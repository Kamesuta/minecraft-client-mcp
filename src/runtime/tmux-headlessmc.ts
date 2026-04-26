import { readFile } from 'node:fs/promises';
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
    await this.sendKeys(`connect ${ip}`);
    return this.waitForConnectResult(ip, before);
  }

  async viewAs(player: string): Promise<ScreenshotResult> {
    await this.sendKeys(`spectate ${player}`);
    await this.sendKeys('F1');
    return this.captureScreenshot(`view_as_${safeName(player)}`);
  }

  async viewAt(target: { x: number; y: number; z: number; yaw: number; pitch: number }): Promise<ScreenshotResult> {
    const { x, y, z, yaw, pitch } = target;
    await this.sendKeys(`tp @p ${x} ${y} ${z} ${yaw} ${pitch}`);
    await this.sendKeys('F1');
    return this.captureScreenshot(`view_at_${safeName(`${x}_${y}_${z}`)}`);
  }

  async command(command: string): Promise<RuntimeResult> {
    await this.sendKeys(command.startsWith('/') ? command.slice(1) : command);
    return { message: `Sent command: ${command}`, meta: { command } };
  }

  async key(key: string): Promise<RuntimeResult> {
    await this.sendKeys(key);
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

  private async sendKeys(keys: string): Promise<void> {
    await execFileAsync('tmux', ['send-keys', '-t', `${this.options.sessionName}:0`, keys, 'C-m']);
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

  private async captureScreenshot(prefix: string): Promise<ScreenshotResult> {
    const screenshotsDir = this.options.screenshotsDir ?? join(process.env.HOME ?? '', 'Library/Application Support/minecraft/screenshots');
    const path = join(screenshotsDir, `${prefix}.png`);
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
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
