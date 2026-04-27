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
cp .env.example .env
npm run dev
```

This project expects `.env` to be present.

```dotenv
MCP_HOST=127.0.0.1
MCP_PORT=3000
HMC_TMUX_SESSION=hmc
HMC_VERSION=1.21.4
HMC_LAUNCHER_COMMAND=java -jar "./headlessmc-launcher.jar"
HMC_SCREENSHOTS_DIR=/Users/your-name/Library/Application Support/minecraft/screenshots
```

## Environment

- `MCP_HOST`
- `MCP_PORT`
- `HMC_TMUX_SESSION`
- `HMC_VERSION`
- `HMC_LAUNCHER_COMMAND`
- `HMC_SCREENSHOTS_DIR`

## Tools

- `hmc_launch` — reuse or start the session detached
- `hmc_quit` — stop HeadlessMC and wait until the tmux session is fully gone
- `hmc_logs` — read recent tmux scrollback
- `hmc_connect` — connect and wait until success or failure is observable in logs
- `hmc_player_command` — run a Minecraft slash command as the in-game player
- `hmc_headlessmc_command` — send a raw HeadlessMC command
- `batch_execute` — send multiple raw HeadlessMC commands in one call
- `hmc_view_as` / `hmc_view_at` — capture screenshots
