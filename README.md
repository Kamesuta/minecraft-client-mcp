# minecraft-client-mcp

FastMCP wrapper around a HeadlessMC tmux session.

## What this is for

This MCP is for capturing screenshots rendered by a real Minecraft client.
It uses HeadlessMC to actually launch Minecraft, render the world, and take screenshots from the client itself.

If your goal is Minecraft automation itself, you will usually want a Mineflayer-based MCP such as
[minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)
instead of this one.

This MCP becomes especially useful when paired with that kind of automation-oriented MCP.

- drive gameplay with a Mineflayer-based MCP
- then capture screenshots from the viewpoint of the actual in-game player
- pass the real rendered screen to an AI, not just bot-side state

In other words, this project is intended to complement automation-oriented MCPs, not replace them.

## What it can do

This MCP mainly supports two screenshot workflows:

- spectate another player and capture screenshots from that player's point of view
- capture screenshots from a specific position and camera direction

Along with the screenshot itself, you can also obtain the `render` result.
This is coarse text information describing what is currently visible in the 3D scene.

That extra `render` output can be useful for AI decision-making when an agent needs lightweight scene awareness in addition to the raw screenshot.

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

See [.env.example](./.env.example) for the expected environment variables.

## Tools

- `hmc_launch` — reuse or start the session detached
- `hmc_quit` — stop HeadlessMC and wait until the tmux session is fully gone
- `hmc_logs` — read recent tmux scrollback
- `hmc_connect` — connect to `host` or `host:port` and wait until success or failure is observable in logs
- `hmc_player_command` — run a Minecraft slash command as the in-game player
- `hmc_headlessmc_command` — send a raw HeadlessMC command
- `batch_execute` — send multiple raw HeadlessMC commands in one call
- `hmc_view_as` / `hmc_view_at` — capture screenshots and collect render output

## Verified environment

- macOS + tmux

## TODO

- Docker + Linux support
