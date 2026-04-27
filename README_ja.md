# minecraft-client-mcp

HeadlessMC を tmux セッション上で扱うための FastMCP ラッパーです。

## 何のためのMCP？

このツールは、「本物の Minecraft」でレンダリングされたスクリーンショットを撮るためのものMCPです。
HeadlessMC を使って実際に Minecraft クライアントを起動し、ワールドを描画し、その実クライアントからスクリーンショットを取得します。

Minecraft 内での自動化そのものが目的であれば、このMCPの代わりに
[minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)
のような Mineflayer ベースの MCP を使うのがおすすめです。

この MCP は、そうした自動化向け MCP と組み合わせて使うと特に役立ちます。

- まず、Mineflayer ベースの MCP でゲームプレイをさせる
- そのうえで、このMCPを使って、実際のゲーム内プレイヤーの視点からスクリーンショットを撮る

つまりこのプロジェクトは、自動化向け MCP を置き換えるものではなく、それを補完するためのものです。

## できること

この MCP では、主に次の 2 つの方法でスクリーンショットを取得できます。

- 他のプレイヤーを `spectate` し、そのプレイヤー視点でスクリーンショットを撮る
- 特定の座標とカメラの向きを指定してスクリーンショットを撮る

また、スクリーンショットそのものに加えて、`render` の結果も取得できます。
これは、3D 空間内で現在見えている内容を、大まかなテキスト情報として表したものです。

この `render` 出力は、AI の判断材料として使えます。
生のスクリーンショットに加えて、軽量なシーン認識情報も渡したいときに便利です。

## 実行方法

```bash
npm install
cp .env.example .env
npm run dev
```

このプロジェクトでは `.env` が必要です。

```dotenv
MCP_HOST=127.0.0.1
MCP_PORT=3000
HMC_TMUX_SESSION=hmc
HMC_VERSION=1.21.4
HMC_LAUNCHER_COMMAND=java -jar "./headlessmc-launcher.jar"
HMC_SCREENSHOTS_DIR=/Users/your-name/Library/Application Support/minecraft/screenshots
```

必要な環境変数は [.env.example](./.env.example) を参照してください。

## ツール

- `hmc_launch` — 既存セッションを再利用するか、detach 状態で新規起動する
- `hmc_quit` — HeadlessMC を停止し、tmux セッションが完全に終了するまで待つ
- `hmc_logs` — tmux の直近スクロールバックを読む
- `hmc_connect` — 接続し、成功または失敗がログ上で確認できるまで待つ
- `hmc_player_command` — ゲーム内プレイヤーとして Minecraft のスラッシュコマンドを実行する
- `hmc_headlessmc_command` — 生の HeadlessMC コマンドを送る
- `batch_execute` — 複数の生 HeadlessMC コマンドをまとめて送る
- `hmc_view_as` / `hmc_view_at` — スクリーンショットを取得し、render 出力も収集する

## 動作確認環境

- macOS + tmux

## TODO

- Docker + Linux 対応
