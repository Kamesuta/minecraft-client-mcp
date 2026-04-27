import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BatchOperation, BatchResult, MinecraftClientRuntime, RuntimeResult, ScreenshotResult } from './types.js';

const execFileAsync = promisify(execFile);

type Options = {
  sessionName: string;
  launcherCommand: string;
  screenshotsDir: string;
  version: string;
};

const CONNECT_TIMEOUT_MS = 20_000;
const CONNECT_POLL_INTERVAL_MS = 500;
const CONNECT_LOG_LINES = 400;
const LAUNCH_TIMEOUT_MS = 30_000;
const LAUNCH_POLL_INTERVAL_MS = 500;
const QUIT_TIMEOUT_MS = 15_000;
const QUIT_POLL_INTERVAL_MS = 250;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const SCREENSHOT_POLL_INTERVAL_MS = 250;
const RENDER_TIMEOUT_MS = 3_000;
const RENDER_POLL_INTERVAL_MS = 100;
const HUD_TOGGLE_SETTLE_MS = 150;
const GUI_TIMEOUT_MS = 3_000;
const GUI_POLL_INTERVAL_MS = 100;
const COMMAND_TIMEOUT_MS = 3_000;
const COMMAND_POLL_INTERVAL_MS = 100;
const COMMAND_SETTLE_MS = 300;
const SPECTATE_TARGET_NOT_FOUND_PATTERNS = [/\bNo entity was found\b/i];

const CONNECT_SUCCESS_PATTERNS = [
  /\bjoined the game\b/i,
  /\bLoaded \d+ advancements\b/i,
];

const CONNECT_FAILURE_PATTERNS = [
  /\bFailed to connect to the server\b/i,
  /\bCouldn't connect to server\b/i,
  /\bConnection refused\b/i,
  /\bUnknown host\b/i,
  /\bDisconnected\b/i,
  /\bConnection reset\b/i,
  /\bTimed out\b/i,
  /\bNetwork is unreachable\b/i,
  /\bNot authenticated with Minecraft\.net\b/i,
  /\bInvalid session\b/i,
];

export class TmuxHeadlessMcAdapter implements MinecraftClientRuntime {
  private hudHidden: boolean | null = null;
  private markerSequence = 0;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {}

  async launch(): Promise<RuntimeResult> {
    return this.withRuntimeLock(async () => {
      const version = this.options.version;
      const exists = await this.hasSession();
      if (exists) {
        return {
          message: `Using existing tmux session ${this.options.sessionName}.`,
          meta: {
            sessionName: this.options.sessionName,
            reusedExistingSession: true,
            version,
          },
        };
      }

      const cmd = this.buildLauncherCommand(`launch ${version}`);
      await execFileAsync('tmux', ['new-session', '-d', '-s', this.options.sessionName, 'zsh', '-c', cmd]);
      await sleep(100);
      const launchLogLine = await this.waitForLaunchResult(version, cmd);
      return {
        message: `Launched detached tmux session ${this.options.sessionName} with HeadlessMC version ${version}.`,
        meta: {
          sessionName: this.options.sessionName,
          version,
          launcherCommand: cmd,
          matchedLine: launchLogLine,
        },
      };
    });
  }

  async quit(): Promise<RuntimeResult> {
    return this.withRuntimeLock(async () => {
      if (!(await this.hasSession())) {
        return {
          message: `tmux session ${this.options.sessionName} is already stopped.`,
          meta: {
            sessionName: this.options.sessionName,
            alreadyStopped: true,
          },
        };
      }

      await this.sendConsoleCommand('quit');
      const graceful = await this.waitForSessionExit(QUIT_TIMEOUT_MS);
      if (graceful) {
        this.hudHidden = null;
        return {
          message: `Stopped tmux session ${this.options.sessionName}.`,
          meta: {
            sessionName: this.options.sessionName,
            shutdown: 'graceful',
          },
        };
      }

      await execFileAsync('tmux', ['kill-session', '-t', this.options.sessionName]);
      const forced = await this.waitForSessionExit(QUIT_TIMEOUT_MS);
      if (!forced) {
        throw new Error(`Timed out waiting for tmux session ${this.options.sessionName} to terminate.`);
      }

      this.hudHidden = null;
      return {
        message: `Stopped tmux session ${this.options.sessionName} after forcing termination.`,
        meta: {
          sessionName: this.options.sessionName,
          shutdown: 'forced',
        },
      };
    });
  }

  async logs(lines = 30): Promise<RuntimeResult> {
    const args = ['capture-pane', '-t', `${this.options.sessionName}:0`, '-p'];
    if (lines > 0) {
      args.push('-S', `-${lines}`);
    }
    const { stdout } = await execFileAsync('tmux', args);
    return {
      message: stdout.trimEnd() || '(no output)',
      meta: { sessionName: this.options.sessionName, lines },
    };
  }

  async connect(ip: string): Promise<RuntimeResult> {
    return this.withRuntimeLock(async () => {
      const before = await this.capturePane(CONNECT_LOG_LINES);
      await this.sendConsoleCommand(`connect ${ip}`);
      const result = await this.waitForConnectResult(ip, before);
      const hudHidden = await this.syncHudHiddenState();
      return {
        ...result,
        meta: {
          ...result.meta,
          hudHidden,
        },
      };
    });
  }

  async viewAs(player: string): Promise<ScreenshotResult> {
    return this.withRuntimeLock(async () => {
      await this.sendChatCommand('gamemode spectator');
      const spectateOutput = await this.executeMinecraftCommand(`spectate ${player}`);
      const spectateFailure = findMatchingLine(
        String(spectateOutput.meta?.commandOutput ?? ''),
        SPECTATE_TARGET_NOT_FOUND_PATTERNS,
      );
      if (spectateFailure) {
        throw new Error(`Failed to spectate ${player}: ${spectateFailure}`);
      }

      return this.captureScreenshot();
    });
  }

  async viewAt(target: { x: number; y: number; z: number; yaw: number; pitch: number }): Promise<ScreenshotResult> {
    return this.withRuntimeLock(async () => {
      const { x, y, z, yaw, pitch } = target;
      await this.sendChatCommand('gamemode spectator');
      await this.sendChatCommand(`tp @s ${x} ${y} ${z} ${yaw} ${pitch}`);
      return this.captureScreenshot();
    });
  }

  async playerCommand(command: string): Promise<RuntimeResult> {
    return this.withRuntimeLock(() => this.executeMinecraftCommand(command));
  }

  async headlessmcCommand(command: string): Promise<RuntimeResult> {
    return this.withRuntimeLock(() => this.executeHeadlessmcCommand(command));
  }

  async batchExecute(operations: BatchOperation[]): Promise<BatchResult> {
    return this.withRuntimeLock(async () => {
      const results: BatchResult['results'] = [];

      for (const [index, operation] of operations.entries()) {
        try {
          const result =
            operation.type === 'player_command'
              ? await this.executeMinecraftCommand(operation.command)
              : await this.executeHeadlessmcCommand(operation.command);

          results.push({
            index,
            type: operation.type,
            ok: true,
            message: result.message,
            meta: result.meta,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            index,
            type: operation.type,
            ok: false,
            message,
          });
          return {
            message: `Batch execution stopped at operation ${index}.`,
            results,
          };
        }
      }

      return {
        message: `Batch executed ${results.length} operations successfully.`,
        results,
      };
    });
  }

  private async sendConsoleCommand(command: string): Promise<void> {
    await execFileAsync('tmux', ['send-keys', '-t', `${this.options.sessionName}:0`, command, 'C-m']);
  }

  private async executeMinecraftCommand(command: string): Promise<RuntimeResult> {
    const trimmed = command.trim().replace(/^\/+/, '');
    const sentCommand = `/${trimmed}`;
    const commandOutput = await this.runCapturedConsoleCommand(sentCommand, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      pollIntervalMs: COMMAND_POLL_INTERVAL_MS,
      settleMs: COMMAND_SETTLE_MS,
    });

    return {
      message: commandOutput ? `Minecraft command result:\n${commandOutput}` : `Sent Minecraft command: /${trimmed}`,
      meta: {
        command: trimmed,
        sentCommand,
        commandOutput,
      },
    };
  }

  private async executeHeadlessmcCommand(
    command: string,
    options: { timeoutMs: number; pollIntervalMs: number; settleMs: number } = {
      timeoutMs: COMMAND_TIMEOUT_MS,
      pollIntervalMs: COMMAND_POLL_INTERVAL_MS,
      settleMs: COMMAND_SETTLE_MS,
    },
  ): Promise<RuntimeResult> {
    const sentCommand = command.trim();
    const commandOutput = await this.runCapturedConsoleCommand(sentCommand, options);

    return {
      message: commandOutput ? `HeadlessMC command result:\n${commandOutput}` : `Sent HeadlessMC command: ${sentCommand}`,
      meta: {
        command: sentCommand,
        sentCommand,
        commandOutput,
      },
    };
  }

  private async sendChatCommand(command: string): Promise<void> {
    await this.sendConsoleCommand(`/${command}`);
  }

  private async pressKey(key: string): Promise<void> {
    await this.sendConsoleCommand(`key ${key.toLowerCase()}`);
  }

  private async capturePane(lines: number): Promise<string> {
    const args = ['capture-pane', '-J', '-t', `${this.options.sessionName}:0`, '-p'];
    if (lines > 0) {
      args.push('-S', `-${lines}`);
    }
    const { stdout } = await execFileAsync('tmux', args);
    return stdout;
  }

  private async hasSession(): Promise<boolean> {
    try {
      await execFileAsync('tmux', ['has-session', '-t', this.options.sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  private buildLauncherCommand(headlessmcCommand?: string): string {
    const base = this.options.launcherCommand;
    if (!headlessmcCommand) {
      return base;
    }

    return `${base} --command ${shellQuote(headlessmcCommand)}`;
  }

  private async captureScreenshot(): Promise<ScreenshotResult> {
    const screenshotsDir = this.options.screenshotsDir;
    const before = await this.listScreenshotFiles(screenshotsDir);
    await this.sendConsoleCommand('close');
    await this.waitForGuiClosed();
    await this.ensureHudHidden();
    const renderText = await this.captureRenderOutput();
    await this.pressKey('f2');
    const path = await this.waitForScreenshotFile(screenshotsDir, before);
    const png = await readFile(path);
    return {
      screenshotPath: path,
      screenshotBase64: png.toString('base64'),
      renderText,
      message: 'Screenshot captured.',
      meta: { screenshotPath: path, renderText },
    };
  }

  private async waitForConnectResult(ip: string, before: string): Promise<RuntimeResult> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let latest = before;

    while (Date.now() < deadline) {
      await sleep(CONNECT_POLL_INTERVAL_MS);
      latest = await this.capturePane(CONNECT_LOG_LINES);
      const delta = stripSharedPrefix(before, latest);
      const matchingLine = findMatchingLine(delta, CONNECT_FAILURE_PATTERNS);
      if (matchingLine) {
        throw new Error(`Failed to connect to ${ip}: ${matchingLine}`);
      }

      const successLine = findMatchingLine(delta, CONNECT_SUCCESS_PATTERNS);
      if (successLine) {
        return {
          message: `Connected to ${ip}`,
          meta: {
            ip,
            status: 'connected',
            matchedLine: successLine,
          },
        };
      }
    }

    const delta = stripSharedPrefix(before, latest).trim();
    const recentLog = tailLines(delta || latest, 20);
    throw new Error(
      `Timed out waiting for connection to ${ip}. Recent output:\n${recentLog || '(no new output)'}`,
    );
  }

  private async waitForLaunchResult(version: string, launcherCommand: string): Promise<string> {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let latest = '';
    const successPatterns = getLaunchSuccessPatterns(version);

    while (Date.now() < deadline) {
      await sleep(LAUNCH_POLL_INTERVAL_MS);
      try {
        latest = await this.capturePane(CONNECT_LOG_LINES);
      } catch (error) {
        if (!(await this.hasSession())) {
          throw new Error(
            [
              `HeadlessMC session ${this.options.sessionName} exited before startup completed for version ${version}.`,
              `Tried launcher command: ${launcherCommand}`,
              'The process likely failed immediately before Minecraft finished loading.',
              'Check the jar path, Java runtime, account/auth state, and whether that version ID is launchable.',
            ].join('\n'),
          );
        }

        throw error;
      }

      const successLine = findMatchingLine(latest, successPatterns);
      if (successLine) {
        return successLine;
      }
    }

    throw new Error(
      `Timed out waiting for HeadlessMC launch ${version}. Recent output:\n${tailLines(latest, 20) || '(no output)'}`,
    );
  }

  private async listScreenshotFiles(screenshotsDir: string): Promise<Map<string, number>> {
    const entries = await readdir(screenshotsDir, { withFileTypes: true });
    const files = new Map<string, number>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.png')) {
        continue;
      }

      const path = join(screenshotsDir, entry.name);
      const info = await stat(path);
      files.set(path, info.mtimeMs);
    }

    return files;
  }

  private async waitForScreenshotFile(screenshotsDir: string, before: Map<string, number>): Promise<string> {
    const deadline = Date.now() + SCREENSHOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(SCREENSHOT_POLL_INTERVAL_MS);
      const current = await this.listScreenshotFiles(screenshotsDir);
      const created = [...current.entries()]
        .filter(([path, mtimeMs]) => !before.has(path) || before.get(path) !== mtimeMs)
        .sort((a, b) => b[1] - a[1]);

      if (created.length > 0) {
        return created[0][0];
      }
    }

    throw new Error(`Timed out waiting for screenshot in ${screenshotsDir}`);
  }

  private async ensureHudHidden(): Promise<void> {
    if (this.hudHidden !== false) {
      return;
    }

    await this.pressKey('f1');
    await sleep(HUD_TOGGLE_SETTLE_MS);
    this.hudHidden = true;
  }

  private async syncHudHiddenState(): Promise<boolean> {
    const firstRender = await this.captureRenderAfterKeyToggle('f3');
    const secondRender = await this.captureRenderAfterKeyToggle('f3');
    const hudVisible = [firstRender, secondRender].some((render) => hasHudMarker(render));

    if (hudVisible) {
      await this.pressKey('f1');
      await sleep(HUD_TOGGLE_SETTLE_MS);
      this.hudHidden = true;
      return true;
    }

    this.hudHidden = true;
    return true;
  }

  private async captureRenderAfterKeyToggle(key: string): Promise<string> {
    await this.pressKey(key);
    await sleep(HUD_TOGGLE_SETTLE_MS);
    return this.captureRenderOutput();
  }

  private async captureRenderOutput(): Promise<string> {
    const output = await this.runCapturedConsoleCommand('render', {
      timeoutMs: RENDER_TIMEOUT_MS,
      pollIntervalMs: RENDER_POLL_INTERVAL_MS,
      settleMs: COMMAND_SETTLE_MS,
    });
    const renderOutput = extractRenderOutput(output);
    if (renderOutput) {
      return renderOutput;
    }

    throw new Error(`Timed out waiting for render output. Recent output:\n${tailLines(output, 20)}`);
  }

  private async waitForGuiClosed(): Promise<void> {
    const deadline = Date.now() + GUI_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const guiOutput = await this.runCapturedConsoleCommand('gui', {
        timeoutMs: GUI_TIMEOUT_MS,
        pollIntervalMs: GUI_POLL_INTERVAL_MS,
        settleMs: COMMAND_SETTLE_MS,
      });

      if (guiOutput.includes('Minecraft is currently not displaying a Gui.')) {
        return;
      }
    }

    throw new Error('Timed out waiting for GUI to close.');
  }

  private async runCapturedConsoleCommand(
    command: string,
    options: { timeoutMs: number; pollIntervalMs: number; settleMs: number },
  ): Promise<string> {
    const startMarker = this.createMarker('start');
    const endMarker = this.createMarker('end');
    const deadline = Date.now() + options.timeoutMs;
    let bestOutput = '';
    let lastChangeAt = 0;

    await this.sendConsoleCommand(startMarker);
    await this.sendConsoleCommand(command);

    while (Date.now() < deadline) {
      await sleep(options.pollIntervalMs);
      const pane = await this.capturePane(CONNECT_LOG_LINES);
      const block = extractBetweenMarkers(pane, startMarker);
      const commandOutput = extractCommandPayload(block, command);
      if (commandOutput !== bestOutput) {
        bestOutput = commandOutput;
        if (commandOutput) {
          lastChangeAt = Date.now();
        }
        continue;
      }

      if (commandOutput && lastChangeAt > 0 && Date.now() - lastChangeAt >= options.settleMs) {
        break;
      }
    }

    await this.sendConsoleCommand(endMarker);

    while (Date.now() < deadline) {
      await sleep(options.pollIntervalMs);
      const pane = await this.capturePane(CONNECT_LOG_LINES);
      const block = extractBetweenMarkers(pane, startMarker, endMarker);
      if (block) {
        return extractCommandPayload(block, command) || bestOutput;
      }
    }

    return bestOutput;
  }

  private createMarker(kind: 'start' | 'end'): string {
    this.markerSequence += 1;
    return `__hmc_${kind}_${Date.now()}_${this.markerSequence}__`;
  }

  private async withRuntimeLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.operationChain;
    let release!: () => void;
    this.operationChain = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function stripSharedPrefix(previous: string, current: string): string {
  if (current.startsWith(previous)) {
    return current.slice(previous.length);
  }

  return current;
}

function findMatchingLine(output: string, patterns: RegExp[]): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      return line;
    }
  }

  return null;
}

function tailLines(output: string, count: number): string {
  return output
    .split('\n')
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

function extractRenderOutput(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd());

  const renderLines: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!collecting) {
      if (!trimmed.startsWith('{')) {
        continue;
      }
      collecting = true;
    }

    if (!trimmed.startsWith('{')) {
      break;
    }

    renderLines.push(trimmed);
  }

  return renderLines.join('\n');
}

function hasHudMarker(renderOutput: string): boolean {
  return renderOutput.includes('XYZ:') || renderOutput.includes('Minecraft ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getLaunchSuccessPatterns(version: string): RegExp[] {
  return [/\[ProcessFactory\]: Game will run in /i];
}

function extractBetweenMarkers(output: string, startMarker: string, endMarker?: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd());
  const startIndex = lines.findLastIndex((line) => line.includes(startMarker));
  if (startIndex === -1) {
    return '';
  }

  const linesAfterStart = lines.slice(startIndex + 1);
  if (!endMarker) {
    return linesAfterStart.join('\n');
  }

  const endIndex = linesAfterStart.findIndex((line) => line.includes(endMarker));
  if (endIndex === -1) {
    return '';
  }

  return linesAfterStart.slice(0, endIndex).join('\n');
}

function extractCommandPayload(output: string, command: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd());
  const commandIndex = lines.findIndex((line) => line.trim() === command);
  if (commandIndex === -1) {
    return '';
  }

  return lines
    .slice(commandIndex + 1)
    .filter((line) => !line.includes('__hmc_'))
    .join('\n')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
