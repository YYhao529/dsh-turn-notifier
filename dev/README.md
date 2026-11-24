# dev/ —— 开发工具（不是插件代码，DSH 不会加载）

| 文件 | 作用 |
| --- | --- |
| `card-selftest.mjs` | 用真实的 `lib/card.ps1` 弹一次卡片并让它自己截图；`--preview` 只渲染外观到 `preview.png` |
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
