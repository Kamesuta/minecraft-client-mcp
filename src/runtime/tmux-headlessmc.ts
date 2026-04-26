import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BatchOperation, BatchResult, MinecraftClientRuntime, RuntimeResult, ScreenshotResult } from './types.js';

const execFileAsync = promisify(execFile);

type Options = {
  sessionName: string;
  launcherCommand?: string;
  screenshotsDir?: string;
};

const CONNECT_TIMEOUT_MS = 20_000;
const CONNECT_POLL_INTERVAL_MS = 500;
const CONNECT_LOG_LINES = 400;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const SCREENSHOT_POLL_INTERVAL_MS = 250;
const RENDER_TIMEOUT_MS = 3_000;
const RENDER_POLL_INTERVAL_MS = 100;
const HUD_TOGGLE_SETTLE_MS = 150;
const GUI_TIMEOUT_MS = 3_000;
const GUI_POLL_INTERVAL_MS = 100;

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

  constructor(private readonly options: Options) {}

  async launch(): Promise<RuntimeResult> {
    const cmd = this.options.launcherCommand ?? 'java -jar "$HOME/headlessmc.jar"';
    const exists = await this.hasSession();
    if (exists) {
      return { message: `Using existing tmux session ${this.options.sessionName}` };
    }

    await execFileAsync('tmux', ['new-session', '-d', '-s', this.options.sessionName, 'zsh', '-lc', cmd]);
    return { message: `Launched detached tmux session ${this.options.sessionName}` };
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
  }

  async viewAs(player: string): Promise<ScreenshotResult> {
    await this.sendChatCommand('gamemode spectator');
    await this.sendChatCommand(`spectate ${player}`);
    return this.captureScreenshot();
  }

  async viewAt(target: { x: number; y: number; z: number; yaw: number; pitch: number }): Promise<ScreenshotResult> {
    const { x, y, z, yaw, pitch } = target;
    await this.sendChatCommand('gamemode spectator');
    await this.sendChatCommand(`tp @s ${x} ${y} ${z} ${yaw} ${pitch}`);
    return this.captureScreenshot();
  }

  async command(command: string): Promise<RuntimeResult> {
    if (command.startsWith('/')) {
      await this.sendChatCommand(command.slice(1));
    } else {
      await this.sendConsoleCommand(command);
    }
    return { message: `Sent command: ${command}`, meta: { command } };
  }

  async key(key: string): Promise<RuntimeResult> {
    await this.pressKey(key);
    return { message: `Sent key: ${key}`, meta: { key } };
  }

  async batchExecute(operations: BatchOperation[]): Promise<BatchResult> {
    const results: BatchResult['results'] = [];

    for (const [index, operation] of operations.entries()) {
      try {
        const result =
          operation.type === 'command'
            ? await this.command(operation.command)
            : await this.key(operation.key);

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
  }

  private async sendConsoleCommand(command: string): Promise<void> {
    await execFileAsync('tmux', ['send-keys', '-t', `${this.options.sessionName}:0`, command, 'C-m']);
  }

  private async sendChatCommand(command: string): Promise<void> {
    await this.sendConsoleCommand(`/${command}`);
  }

  private async pressKey(key: string): Promise<void> {
    await this.sendConsoleCommand(`key ${key.toLowerCase()}`);
  }

  private async capturePane(lines: number): Promise<string> {
    const args = ['capture-pane', '-t', `${this.options.sessionName}:0`, '-p'];
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

  private async captureScreenshot(): Promise<ScreenshotResult> {
    const screenshotsDir = this.options.screenshotsDir ?? join(process.env.HOME ?? '', 'Library/Application Support/minecraft/screenshots');
    const before = await this.listScreenshotFiles(screenshotsDir);
    await this.sendConsoleCommand('close');
    await this.waitForGuiClosed();
    await this.ensureHudHidden();
    await this.pressKey('f2');
    const path = await this.waitForScreenshotFile(screenshotsDir, before);
    const png = await readFile(path);
    return {
      screenshotPath: path,
      screenshotBase64: png.toString('base64'),
      renderText: 'Render output is not yet wired. This adapter will later provide a structured render result.',
      message: 'Screenshot captured.',
      meta: { screenshotPath: path },
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
    const before = await this.capturePane(CONNECT_LOG_LINES);
    await this.sendConsoleCommand('render');
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let latest = before;

    while (Date.now() < deadline) {
      await sleep(RENDER_POLL_INTERVAL_MS);
      latest = await this.capturePane(CONNECT_LOG_LINES);
      const delta = stripSharedPrefix(before, latest);
      const renderOutput = extractRenderOutput(delta);
      if (renderOutput) {
        return renderOutput;
      }
    }

    throw new Error(`Timed out waiting for render output. Recent output:\n${tailLines(latest, 20)}`);
  }

  private async waitForGuiClosed(): Promise<void> {
    const deadline = Date.now() + GUI_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const before = await this.capturePane(CONNECT_LOG_LINES);
      await this.sendConsoleCommand('gui');

      await sleep(GUI_POLL_INTERVAL_MS);

      const latest = await this.capturePane(CONNECT_LOG_LINES);
      const delta = stripSharedPrefix(before, latest);
      const guiOutput = extractCommandOutput(delta, 'gui');
      if (!guiOutput) {
        continue;
      }

      if (guiOutput.includes('Minecraft is currently not displaying a Gui.')) {
        return;
      }
    }

    throw new Error('Timed out waiting for GUI to close.');
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
  return extractCommandOutput(output, 'render')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .join('\n');
}

function hasHudMarker(renderOutput: string): boolean {
  return renderOutput.includes('XYZ:') || renderOutput.includes('Minecraft ');
}

function extractCommandOutput(output: string, command: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd());

  const commandIndex = lines.findIndex((line) => line.trim() === command);
  if (commandIndex === -1) {
    return '';
  }

  return lines.slice(commandIndex + 1).join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
