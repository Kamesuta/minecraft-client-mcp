import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { TmuxHeadlessMcAdapter } from './runtime/tmux-headlessmc.js';
import { createScreenshotResult, createTextResult } from './mcp/results.js';
import { createBatchResult } from './mcp/batch.js';

type SessionData = {
  headers: Record<string, string | string[] | undefined>;
};

const server = new FastMCP<SessionData>({
  authenticate: async (request) => ({
    headers: request.headers,
  }),
  name: 'minecraft-client-mcp',
  version: '0.1.0',
});

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const app = server.getApp();

const runtime = new TmuxHeadlessMcAdapter({
  sessionName: config.sessionName,
  launcherCommand: config.launcherCommand,
  workdir: config.workdir,
  screenshotsDir: config.screenshotsDir,
  version: config.version,
});

app.get('/files/:file', async (c) => {
  const file = c.req.param('file');
  if (!file || basename(file) !== file || !file.endsWith('.png')) {
    return c.json({ error: 'File not found' }, 404);
  }

  const filePath = resolve(config.screenshotsDir, file);

  try {
    const png = await readFile(filePath);
    return c.body(png, 200, {
      'content-disposition': `inline; filename=${JSON.stringify(file)}`,
      'content-type': 'image/png',
    });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

server.addTool({
  name: 'hmc_launch',
  description:
    'Launch or reuse the detached HeadlessMC tmux session. Run this before other hmc_* tools when needed.',
  parameters: z.object({}),
  execute: async () => {
    const result = await runtime.launch();
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_quit',
  description:
    'Ask HeadlessMC to quit, then wait until the backing tmux session is fully gone. Force-kills the session if graceful shutdown stalls.',
  parameters: z.object({}),
  execute: async () => {
    const result = await runtime.quit();
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_logs',
  description:
    'Read recent HeadlessMC output from tmux scrollback without attaching to the session.',
  parameters: z.object({ lines: z.number().int().positive().max(2000).default(120) }),
  execute: async ({ lines }) => {
    const result = await runtime.logs(lines);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_connect',
  description:
    'Connect the HeadlessMC client to a multiplayer server by IP or host:port.',
  parameters: z.object({ ip: z.string().min(1) }),
  execute: async ({ ip }) => {
    const result = await runtime.connect(ip);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_view_as',
  description:
    'Capture a screenshot while spectating a specific player.',
  parameters: z.object({ player: z.string().min(1) }),
  execute: async ({ player }, context) => {
    const result = await runtime.viewAs(player);
    result.screenshotUrl = buildScreenshotUrl(context.session?.headers, result.screenshotPath);
    return createScreenshotResult(result);
  },
});

server.addTool({
  name: 'hmc_view_at',
  description:
    'Capture a screenshot from a specific world position and camera angle.',
  parameters: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    yaw: z.number(),
    pitch: z.number(),
  }),
  execute: async ({ x, y, z, yaw, pitch }, context) => {
    const result = await runtime.viewAt({ x, y, z, yaw, pitch });
    result.screenshotUrl = buildScreenshotUrl(context.session?.headers, result.screenshotPath);
    return createScreenshotResult(result);
  },
});

server.addTool({
  name: 'hmc_player_command',
  description:
    'Run a Minecraft slash command as the in-game player, including player-only commands or ones unsuitable for server console.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: async ({ command }) => {
    const result = await runtime.playerCommand(command);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_headlessmc_command',
  description:
    'Send a raw HeadlessMC command for client control, inspection, or automation. Run help to see available commands.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: async ({ command }) => {
    const result = await runtime.headlessmcCommand(command);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'batch_execute',
  description:
    'Execute multiple player or HeadlessMC commands in one call with an explicit type for each operation.',
  parameters: z.object({
    operations: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('player_command'), command: z.string().min(1) }),
          z.object({ type: z.literal('headlessmc_command'), command: z.string().min(1) }),
        ]),
      )
      .min(1)
      .max(25),
  }),
  execute: async ({ operations }) => {
    const result = await runtime.batchExecute(operations);
    return createBatchResult(result);
  },
});

await server.start({
  transportType: 'httpStream',
  httpStream: {
    port: config.port,
    host: config.host,
  },
});

function loadConfig(): {
  host: string;
  port: number;
  sessionName: string;
  launcherCommand: string;
  workdir: string;
  screenshotsDir: string;
  version: string;
} {
  const host = requireEnv('MCP_HOST');
  const portValue = requireEnv('MCP_PORT');
  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`MCP_PORT must be a positive integer, got: ${portValue}`);
  }

  return {
    host,
    port,
    sessionName: requireEnv('HMC_TMUX_SESSION'),
    launcherCommand: expandAppDir(requireEnv('HMC_LAUNCHER_COMMAND'), appDir),
    workdir: requireEnv('HMC_WORKDIR'),
    screenshotsDir: requireEnv('HMC_SCREENSHOTS_DIR'),
    version: requireEnv('HMC_VERSION'),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Set it in .env.`);
  }

  return value;
}

function expandAppDir(value: string, currentAppDir: string): string {
  return value
    .replaceAll('$APPDIR', currentAppDir)
    .replaceAll('${APPDIR}', currentAppDir);
}

function buildScreenshotUrl(
  headers: Record<string, string | string[] | undefined> | undefined,
  screenshotPath: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const host = firstHeader(headers['x-forwarded-host']) ?? firstHeader(headers.host);
  if (!host) {
    return undefined;
  }

  const proto = firstHeader(headers['x-forwarded-proto']) ?? 'http';
  const file = basename(screenshotPath);
  return `${proto}://${host}/files/${encodeURIComponent(file)}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return firstHeader(value[0]);
  }

  return value
    ?.split(',')
    .map((part) => part.trim())
    .find(Boolean);
}
