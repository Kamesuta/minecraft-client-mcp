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
    'Launch or reuse the HeadlessMC client runtime without attaching to tmux. Use this before any other hmc_* tool if the Minecraft client may not already be running. This tool is safe to call more than once when backed by a persistent tmux session. Recommended first step for a fresh session, after a reboot, or after any runtime failure.',
  parameters: z.object({}),
  execute: async () => {
    const result = await runtime.launch();
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_logs',
  description:
    'Read recent HeadlessMC output from the tmux scrollback without attaching to the session. Use this to inspect launcher output, disconnects, or runtime errors.',
  parameters: z.object({ lines: z.number().int().positive().max(2000).default(120) }),
  execute: async ({ lines }) => {
    const result = await runtime.logs(lines);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_connect',
  description:
    'Connect the HeadlessMC client to a multiplayer server by IP or host:port. Use this only after hmc_launch has succeeded and the client is ready to accept commands. Prefer this tool over sending raw connect text through hmc_headlessmc_command because this tool expresses clear intent and is easier for an AI agent to choose correctly.',
  parameters: z.object({ ip: z.string().min(1) }),
  execute: async ({ ip }) => {
    const result = await runtime.connect(ip);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_view_as',
  description:
    'Capture a screenshot while viewing a specific player. Use this when the target is a player, not a coordinate.',
  parameters: z.object({ player: z.string().min(1) }),
  execute: async ({ player }) => {
    const result = await runtime.viewAs(player);
    return createScreenshotResult(result);
  },
});

server.addTool({
  name: 'hmc_view_at',
  description:
    'Capture a screenshot from a specific world position and camera angle. Use this when the target is a coordinate or fixed viewpoint. Prefer this over manual command chains for exact shots.',
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
    'Send a Minecraft slash command as the in-game player controlled by HeadlessMC. Use this for player-context actions that need to run from the client side, including commands that may not be executable from the server console or that depend on the player as the executor. This is especially useful for player-only commands such as local movement, camera, world interaction, or plugin commands that behave differently for players than for console. Do not prefer this for connecting or camera capture flows when hmc_connect, hmc_view_as, or hmc_view_at already express the intent directly.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: async ({ command }) => {
    const result = await runtime.playerCommand(command);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_headlessmc_command',
  description:
    'Send a raw HeadlessMC command exactly as typed. Use this for HeadlessMC runtime controls and other non-Minecraft commands such as connect, render, gui, close, or similar low-level client operations. Prefer hmc_player_command when the intent is to run a Minecraft slash command as the player.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: async ({ command }) => {
    const result = await runtime.headlessmcCommand(command);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'batch_execute',
  description:
    'Execute multiple raw HeadlessMC commands in a single call for better reliability and lower latency. Prefer hmc_player_command for Minecraft slash commands that should run as the player.',
  parameters: z.object({
    operations: z
      .array(
        z.discriminatedUnion('type', [z.object({ type: z.literal('command'), command: z.string().min(1) })]),
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
