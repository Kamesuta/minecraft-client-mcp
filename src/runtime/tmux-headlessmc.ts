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

export class TmuxHeadlessMcAdapter implements MinecraftClientRuntime {
  constructor(private readonly options: Options) {}

  async launch(): Promise<RuntimeResult> {
    const cmd = this.options.launcherCommand ?? "zsh -lic 'java -jar \"$HOME/headlessmc.jar\"'";
    await execFileAsync('tmux', ['new-session', '-Ad', '-s', this.options.sessionName, cmd]);
    return { message: `Launched tmux session ${this.options.sessionName}` };
  }

  async connect(ip: string): Promise<RuntimeResult> {
    await this.sendKeys(`connect ${ip}`);
    return { message: `Sent connect command to ${ip}`, meta: { ip } };
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
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}
