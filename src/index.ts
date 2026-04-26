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
    'Connect the HeadlessMC client to a multiplayer server by IP or host:port. Use this only after hmc_launch has succeeded and the client is ready to accept commands. Prefer this tool over sending raw connect text through hmc_command because this tool expresses clear intent and is easier for an AI agent to choose correctly.',
  parameters: z.object({ ip: z.string().min(1) }),
  execute: async ({ ip }) => {
    const result = await runtime.connect(ip);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_view_as',
  description:
    'Capture a screenshot while viewing a specific player. Use this when the target is a player, not a coordinate. Prefer this over combining hmc_command and hmc_key manually.',
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
  name: 'hmc_command',
  description:
    'Send a raw Minecraft command or chat-style control command to the HeadlessMC client. Use this for advanced actions that do not yet have a dedicated high-level MCP tool, such as world commands, gamemode changes, teleportation, or server-specific commands. Do not prefer this for connect or camera flows when hmc_connect, hmc_view_as, or hmc_view_at can express the intent directly. This is a lower-level escape hatch and is more error-prone for autonomous agents.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: async ({ command }) => {
    const result = await runtime.command(command);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'hmc_key',
  description:
    'Send a raw key input to the HeadlessMC client. Use this only for interactions that genuinely require client keypresses, such as toggling F1, moving briefly, opening UI, or handling controls that are not exposed through a dedicated tool. Avoid using this for multi-step camera orchestration when a higher-level tool exists, because raw key automation is timing-sensitive and much less reliable for LLM-driven control.',
  parameters: z.object({ key: z.string().min(1) }),
  execute: async ({ key }) => {
    const result = await runtime.key(key);
    return createTextResult(result.message, result.meta);
  },
});

server.addTool({
  name: 'batch_execute',
  description:
    'Execute multiple low-level HeadlessMC operations in a single call for better reliability and lower latency. Strongly recommended when an AI agent needs to send several raw Minecraft commands or key presses in sequence. Prefer this over many separate hmc_command or hmc_key calls for repetitive work. For camera capture workflows, still prefer hmc_view_as or hmc_view_at when they match the intent. This batch tool currently supports only command and key operations, executes them in order, and stops on the first failure.',
  parameters: z.object({
    operations: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('command'), command: z.string().min(1) }),
          z.object({ type: z.literal('key'), key: z.string().min(1) }),
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
