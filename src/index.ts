import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { TmuxHeadlessMcAdapter } from './runtime/tmux-headlessmc.js';
import { createScreenshotResult, createTextResult } from './mcp/results.js';
import { createBatchResult } from './mcp/batch.js';

const server = new FastMCP({
  name: 'minecraft-client-mcp',
  version: '0.1.0',
});

const runtime = new TmuxHeadlessMcAdapter({
  sessionName: process.env.HMC_TMUX_SESSION ?? 'hmc',
  launcherCommand: process.env.HMC_LAUNCHER_COMMAND,
  screenshotsDir: process.env.HMC_SCREENSHOTS_DIR,
});

server.addTool({
  name: 'hmc_launch',
  description:
    'Launch or reuse the detached HeadlessMC tmux session. Run this before other hmc_* tools when needed.',
  parameters: z.object({ version: z.string().min(1).optional() }),
  execute: async ({ version }) => {
    const result = await runtime.launch(version);
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
  execute: async ({ player }) => {
    const result = await runtime.viewAs(player);
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
  execute: async ({ x, y, z, yaw, pitch }) => {
    const result = await runtime.viewAt({ x, y, z, yaw, pitch });
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

const port = Number(process.env.MCP_PORT ?? 3000);
await server.start({
  transportType: 'httpStream',
  httpStream: {
    port,
    host: process.env.MCP_HOST ?? '0.0.0.0',
  },
});
