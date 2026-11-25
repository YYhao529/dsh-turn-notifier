# dev/ —— 开发工具（不是插件代码，DSH 不会加载）

| 文件 | 作用 |
| --- | --- |
| `card-selftest.mjs` | 用真实的 `lib/card.ps1` 弹一次卡片并让它自己截图；`--preview` 只渲染外观到 `preview.png`；可选参数 `[heading] [title] [duration] [turnCost] [todayCost]` |
| `host-replay.mjs` | 用假 `ctx` 跑真的 `apply(ctx)`，把真实会话日志里的 `session/event` 逐条喂进去，验证卡片金额；账本写到临时目录，不动 `data/usage.json`；`--backfill` 改为让插件自己补记本机今天的日志 |
| `backfill-probe.mjs` | 只跑启动补记：几个日志、多少事件、多少钱、几毫秒（内存记账，不碰账本） |
| `restart-check.mjs` | 用同一本临时账本「重启」两次，验证补记不会把今天的钱算两遍（会真的读本机今天的日志） |
| `session-probe.mjs` | 逐帧解开 `session.v4.jsonl.zstd`（Node 的 zstd 只解第一帧），打印事件类型计数、每步用量与金额；`--events` 全打印，`--json` 出 JSON |
| `asar-index.cjs` | 列出 `app.asar` 里全部文件路径 → 同目录 `asar-index.txt` |
| `asar-extract.cjs` | 从 `app.asar` 解出指定文件到 `dev/out/` |
| `asar-grep.cjs` | 直接在 `app.asar` 里按字符串搜，先定位文件再解包 |
| `ctx-grep.cjs` | 在大文件里按关键词打印上下文（压缩后的客户端包很好用） |

## 预览 / 自测卡片

```bash
node dev/card-selftest.mjs --preview          # 渲染到 preview.png，不弹窗、不截图
node dev/card-selftest.mjs                    # 真弹一次，卡片进程自己截图到 dev/shot-selftest.png
node dev/card-selftest.mjs "任务完成" "《修 bug》 · 用时 40 秒"
```

截图必须由卡片进程自己拍：从另一个进程 `CopyFromScreen` 这块区域拿到过陈旧帧，
会让人误以为卡片没显示（这个坑踩了很久）。

## 查 DSH 源码

```bash
node dev/asar-index.cjs
findstr /i "ui-session" dev/asar-index.txt
node dev/asar-extract.cjs /dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js
node dev/ctx-grep.cjs dev/out/_dsh_node_modules_@deepseek-ai_dsh-client-ui-session_lib_client.js "api-session/status"
node dev/asar-grep.cjs "api-session/status"     # 不知道在哪个文件时先这样找
```

`app.asar` 默认在 `D:/DeepSeekHarness/resources/app.asar`，换机器时用环境变量覆盖：

```powershell
$env:DSH_ASAR = 'C:/somewhere/resources/app.asar'; node dev/asar-index.cjs
```

`dev/out/`、`dev/asar-index.txt`、`dev/shot-selftest.png` 都是可再生的中间产物，随时可以删。

## 回放真实会话（验证金额）

```bash
node dev/host-replay.mjs                                  # 自动取今天最新的会话日志
node dev/host-replay.mjs --quiet "C:/Users/BDA/.dsh/sessions/--C-...--/session-xxxx/session.v4.jsonl.zstd"
node dev/host-replay.mjs --backfill                       # 不回放单条日志，让插件自己补记本机今天的全部日志
node dev/backfill-probe.mjs                               # 只测补记：日志数 / 事件数 / 金额 / 耗时
node dev/session-probe.mjs "C:/Users/BDA/.dsh/sessions/.../session.v4.jsonl.zstd" --json
```

`host-replay.mjs` 会把 `TURN_NOTIFIER_LEDGER` 指到 `%TMP%/turn-notifier-replay-<pid>/usage.json`，
所以怎么跑都不会污染机器上真实的今日累计。三者都靠 `lib/cost.js`，和插件运行时用的是同一份计价代码；
`--backfill` 与 `backfill-probe.mjs` 还共用 `lib/backfill.js`，即启动补记本身。
`--backfill` 会等账本真的被重写（最多 30 秒）再打印，所以能直接看出补记有没有把今天的钱算两遍。

会话日志位置：`~/.dsh/sessions/<工作区目录名>/session-<id>/session.v4.jsonl.zstd`，
目录名里的中文按 `~6742~9879` 这种码位转义（`杂项` = `~6742~9879`）。
