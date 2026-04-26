# minecraft-client-mcp

FastMCP wrapper around a HeadlessMC tmux session.

## Status

This is the initial implementation scaffold. It is intentionally split into:

- MCP surface (`src/index.ts`)
- runtime adapter (`src/runtime/tmux-headlessmc.ts`)
- result formatting (`src/mcp/results.ts`)

That separation is meant to make a later Docker backend swap easier.

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
