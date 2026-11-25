# dsh-turn-notifier（任务完成提醒）

你去干别的事，DSH 里的任务跑完时，屏幕右下角弹一张卡片、响一声——不用一直盯着页面。卡片上还写着这一轮花了多少钱、今天一共花了多少钱。

![提醒卡片](preview.png)

> 只想看怎么用、出问题怎么查 → 看 [使用手册.md](使用手册.md)。本文件面向开发者，讲实现与安装细节。

## 行为

- **什么时候提醒**：任意会话的回合结束时（宿主把该会话的 `running` 从 `true` 改成 `false`）。
- **什么时候不提醒**：DSH 窗口在最前面时不弹卡片（你正看着答案）；内部子代理会话结束也不提醒（`origin === 'subagent'`，那些是内部步骤，父会话的结果才是你要看的）。
- **提醒长什么样**：右下角一张深色卡片，标题「任务完成」，正文「《会话标题》 · 用时 2 分 05 秒」，正文下面一行是金额：「本次 ¥0.0042」在左、「今日累计 ¥1.2836」在右；点卡片会把 DSH 窗口拿到前台；15 秒后自动消失，鼠标停在上面时不倒计时。卡片固定大小（本机实测 560×176）；一行放不下时标题折两行并省略，**用时和金额永远完整显示**。
- **窗口最小化时**：另外把网页标题改成 `🔔 任务完成`，任务栏上能看见；回到窗口自动还原。

## 花费是怎么算的

DSH 只记 token，不记钱：`TokenUsage` 里没有任何价格字段，也没有按天查询的接口。所以金额由本插件自己算：

- **token 从哪来**：每次模型请求结束时，宿主会把用量写进持久化事件 `assistant/message`（`data.usage` = `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`，`data.message.source` = `{provider, model}`）。插件订阅 `session/event`，按 `(turn, step)` 去重后累加——`inputTokens` 供应商侧已经是「未命中缓存的余量」（`prompt_tokens - cache_read - cache_write`），所以直接按未命中价计费；`cacheWriteTokens` 没有对应价格，也按未命中计。
- **单价**（人民币 / 百万 token，来自官方价格页）：

  | 模型 | 缓存命中 | 缓存未命中 | 输出 |
  | --- | --- | --- | --- |
  | `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
  | `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

  每格是「错峰 / 高峰」。高峰 = 北京时间周一至周五（法定节假日除外）的 09:00–12:00 与 14:00–18:00，其余时间错峰半价。计费时刻取用量上报那一刻（流里 `usage` 块的 `time`），跨过 12:00 或 18:00 的请求各按各的价。
- **「本次」**：一个运行窗口内该会话累计金额的增量——`api-session/status` 变 `running` 时记下当前累计值作基线，变回 `false` 时相减。窗口里有多次请求、重试、工具循环，都算在这一轮里。
- **「今日」**：账本 `data/usage.json` 里按北京日期累加的总数（`{"version":1,"days":{"2026-11-25":1583523}}`，单位是「微元」，整数存，避免浮点误差）。账本只保留最近若干天，插件启动时读回。
- **重启后为什么不会从 ¥0 开始**：DSH 自己没有按天查询的接口，但今天的用量就在会话日志里（`~/.dsh/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`）。插件启动时会把这些日志逐帧解开，只挑今天的事件重新过一遍计价，所以刚重启、还没弹过卡片时「今日累计」也是今天真实的数（本机实测 4 个日志 / 7700 余条事件，约 1.9 秒，后台跑，不挡启动）。日志里已经有的和账本里已经记的不会算两遍——补记前会先清掉账本里「今天」那一格，再由日志重建，同一个 `(turn, step)` 只结算一次。
- **和平台账单的差别**：统计的是这台机器上 DSH 写入的会话日志，加上插件运行期间实时看到的请求。别的设备/网页用的额度不在里面；金额按公开价目表算，平台如果有优惠/赠送额度，卡片不会体现。

## 为什么不用 Windows 系统通知

这台机器的系统通知通道是关死的，任何应用（包括本应用）都弹不出来：

- `HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled = 0`（系统级关闭）；
- 应用主进程从未 `setAppUserModelId`，也没有 AUMID 条目，用 PowerShell 注册 AUMID 并 `CreateToastNotifier(...).Show()` 时调用不报错，但屏幕上什么都不出现，`Notifications\Settings` 下也从不新增子键。

所以提醒改成自己画：宿主半侧 `spawn` 一个短命的 PowerShell 进程，用 WinForms 画卡片（`lib/card.ps1`）。这条路在这台机器上已实测可见。

## 实现要点

- **宿主半侧** `index.js`：`ctx.on('api-session/status', ...)` 跟踪每个会话的 running 状态，`true → false` 时算用时、用 `ctx.get('sessionQuery').readTitleSnapshot(sessionId)` 取标题、`showCard()` 起卡片。
  - 事件契约：`api-session/status` 与官方 `ui-session-status` 插件订阅的是同一个 Remote 事件（其白名单在 `dsh-api-remotes/src/remote-events.ts`），无需轮询。
  - 子进程**不能** `detached: true`：它会跟着本进程的 job object 一起被杀掉，卡片永远不出现。
  - 脚本经 UTF-8（带 BOM）临时文件 + `Invoke-Expression` 交接：`-EncodedCommand` 的 base64 会让命令行超长（`spawn ENAMETOOLONG`），而本机执行策略禁止直接跑 `.ps1` 文件，所以要读成文本再执行。
- **卡片** `lib/card.ps1`：
  - 尺寸固定为 560×176，每次提醒占的屏幕一样大；
  - 正文一行放得下就单行显示（在预留的两行高度里垂直居中），放不下就折两行——标题允许截断加省略号，用时作为独立的一段右对齐放在第二行，永远完整；
  - 无控制台的进程第一次 `ShowWindow` 会沿用隐藏，所以 `Show()` 之后要显式 `ShowWindow(hwnd, SW_SHOWNOACTIVATE)` + `SetWindowPos(HWND_TOPMOST, SWP_SHOWWINDOW)`；
  - 整张卡片一次性画进 Bitmap，`Paint` 里只 `DrawImageUnscaled`——直接往窗体上画字，在首次绘制时会被整块跳过；
  - emoji（✅ 之类）在 `Graphics.DrawString` 里会整行消失，所以对勾是画出来的图形，不是字符；
  - 屏幕缩放 200% 时按物理像素布局，脚本开头先 `SetProcessDPIAware()`。
- **浏览器半侧** `client.js`：纯副作用插件，只做标题标记；`inject: ['sessions', 'remote']`，监听都挂在 `ctx.effect` 里由清理函数回收，卸载/热重载不残留。
- **计价与账本** `lib/cost.js` / `lib/ledger.js`：`CostTracker` 把用量折成微元整数（`PRICES` + `isPeakTime` + `resolveModel`，未知模型回落到 `FALLBACK_MODEL`），`TurnMeter` 在它之上管运行窗口的基线；`lib/ledger.js` 用 `.tmp` + `rename` 原子写，账本目录不存在时自动建。付钱的部分全是纯函数，`test/cost.mjs` 离线断言，不碰网络也不碰真实账本。

## 安装状态（这台机器）

已经装进 `desktop` profile：

- `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-turn-notifier`；
- 依赖写成了 `link:C:/Users/HJYS/Desktop/杂项/dsh-turn-notifier`，所以改本目录的文件后，重载插件条目（插件管理页关一下再开）或重启 DSH 就生效，不用重新安装。

## 自测

```
cd dsh-turn-notifier
npm test                                 # 浏览器半侧 11 项 + 计价/账本 28 项 + 补记 9 项
node test/smoke.mjs                      # 只跑浏览器半侧
node test/cost.mjs                       # 只跑计价、账本、运行窗口
node test/backfill.mjs                   # 只跑启动补记（含"重启不翻倍"）
node dev/host-replay.mjs                 # 用真实会话日志回放宿主半侧（写临时账本）
node dev/host-replay.mjs --backfill      # 让插件自己补记本机今天的真实日志
node dev/backfill-probe.mjs              # 只测补记：几个日志、多少事件、多少钱、几毫秒
node dev/session-probe.mjs <日志路径>     # 逐帧解开 session.v4.jsonl.zstd，打印用量与金额
node dev/card-selftest.mjs               # 真弹一次卡片，并让它自己截图
node dev/card-selftest.mjs --preview     # 只渲染卡片外观到 preview.png
```

`test/smoke.mjs` 用 vm 造一个假的 `window/document` 跑 `client.js`，覆盖：后台结束标记标题、可见时不标记、子代理不标记、加载基线不误报、重复事件不重复、focus/点击/可见性变化还原、卸载后监听清零。

`test/cost.mjs` 全部离线：价目表与峰谷切换、缓存写入按未命中、未知模型回落、同一 `(turn, step)` 不重复计费/换值替换、重试累加、`request/header` 兜底、跨日不串账、运行窗口增量与重复 running 事件、账本只保留近几天。

`test/backfill.mjs` 用临时目录造会话日志：只挑今天动过的日志、回放金额与直接计价一致、昨天的事件不计入今天、回放与实时重叠只结算一次、坏日志只记一笔失败、`DSH_HOME` 覆盖、以及最要紧的一条——**账本里已经有今天、日志里也有今天时，补记后不会翻倍**（它会在插件真的把账本重写一遍之后才断言，不是看初始值）。

`dev/host-replay.mjs` 把 `TURN_NOTIFIER_LEDGER` 指到临时目录，用假 `ctx` 跑真的 `apply(ctx)`，逐条喂真实会话日志里的事件——用于验证"卡片金额 = 日志里所有请求的和"，不会污染真实账本。

## 目录

插件的全部代码、测试、以及开发时用的小工具都在这个目录里：

```
dsh-turn-notifier/
├── package.json         # dsh.bundle / dsh.client 清单
├── cordis.patch.yml     # 往插件树里插入 turn-notifier 这一条
├── index.js             # 宿主半侧：监听状态、算钱、起卡片
├── lib/card.ps1         # 卡片脚本（PowerShell + WinForms）
├── lib/cost.js          # 价目表、峰谷判断、微元换算、运行窗口基线
├── lib/ledger.js        # data/usage.json 的原子读写
├── lib/backfill.js      # 启动时回放今天的会话日志
├── lib/log-frames.js    # 多帧 zstd 会话日志的解码
├── client.js            # 浏览器半侧：标题标记
├── icon.svg             # 插件列表里的图标
├── preview.png          # 卡片外观（README 里的图）
├── data/usage.json      # 运行时生成：按北京日期的每日累计（别提交）
├── 使用手册.md           # 给用户看的：怎么用、没弹怎么查
├── test/
│   ├── smoke.mjs        # 浏览器半侧冒烟测试
│   ├── cost.mjs         # 计价 / 账本 / 运行窗口单测
│   └── backfill.mjs     # 启动补记单测
└── dev/                 # 查 DSH 源码 / 预览卡片 / 回放日志用（DSH 不加载，见 dev/README.md）
    ├── asar-index.cjs
    ├── asar-extract.cjs
    ├── asar-grep.cjs
    ├── ctx-grep.cjs
    ├── card-selftest.mjs
    ├── host-replay.mjs
    ├── backfill-probe.mjs
    └── session-probe.mjs
```

`data/` 是运行时状态，不进 `package.json` 的 `files`；想清空今日累计就删掉 `data/usage.json`——注意下次启动会从今天的会话日志把它重建回来，真要「从零开始」得连日志一起换（或者把 `TURN_NOTIFIER_BACKFILL` 设成 `0` 关掉补记）。

## 已知边界

- DSH 完全退出时不会提醒（进程没了）；重新打开后会话状态还在。
- 只提醒"回合结束"，不提醒"等你批准/回答"这类中间停顿。
- 多个会话同时结束会各弹一张卡片。
- 金额是估算：按公开价目表计费，平台侧的优惠/赠送额度不体现；统计范围是本机会话日志里今天的请求（启动补记）+ 插件运行期间实时看到的请求，别的设备或网页用的额度不算。
- 启动补记的耗时跟今天的日志大小有关（本机 4 个日志约 1.9 秒），它在后台跑，不影响弹卡片；不想付这个开销可以设 `TURN_NOTIFIER_BACKFILL=0`，代价是重启后「今日累计」只算重启之后的。
- DSH 窗口在最前面时不弹卡片，所以那一轮看不到金额（控制台里仍有 `[turn-notifier] 本次消耗 …`）。
- 一个运行窗口里若换了模型，每一笔仍按该笔上报时自己的模型计价。
- 同时开两个 DSH 实例时它们共写一份账本，后写的覆盖先写的（各自仍能正确显示本轮金额）。
