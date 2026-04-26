# minecraft-client-mcp

FastMCP wrapper around a HeadlessMC tmux session.

## Status

This is the initial implementation scaffold. It is intentionally split into:

- MCP surface (`src/index.ts`)
- runtime adapter (`src/runtime/tmux-headlessmc.ts`)
- result formatting (`src/mcp/results.ts`)

That separation is meant to make a later Docker backend swap easier.

## tmux model

- Never attach to the HeadlessMC tmux session from MCP.
- Reuse an existing session if present.
- Otherwise create it detached.
- Use tmux capture-pane for logs and tmux send-keys for interaction.

## Run

```bash
npm install
npm run dev
```

## Environment

- `MCP_HOST` (default `127.0.0.1`)
- `MCP_PORT` (default `3000`)
- `HMC_TMUX_SESSION` (default `hmc`)
- `HMC_LAUNCHER_COMMAND`
- `HMC_SCREENSHOTS_DIR`

## Tools

- `hmc_launch` — reuse or start the session detached
- `hmc_logs` — read recent tmux scrollback
- `hmc_connect` — connect and wait until success or failure is observable in logs
- `hmc_command` — send a raw command
- `hmc_key` — send a raw key
- `hmc_view_as` / `hmc_view_at` — capture screenshots
