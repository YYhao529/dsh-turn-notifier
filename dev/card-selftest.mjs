// End-to-end check of the real card path: render lib/card.ps1 exactly like the
// host does. Two modes:
//
//   node dev/card-selftest.mjs [heading] [title] [duration] [turnCost] [todayCost]
//       TURN_NOTIFIER_SKIP_FOREGROUND=1 reproduces the production rule (no card
//       while the Harness window is in front)
//       show the card and let the card process screenshot itself (capturing the
//       desktop from a second process proved unreliable here)
//
//   node dev/card-selftest.mjs --preview ../preview.png [heading] [title] [duration] [turnCost] [todayCost]
//       render the card face straight to a PNG without showing any window
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const cardPath = here('../lib/card.ps1')
const shotPath = here('./shot-selftest.png')
const quote = (value) => String(value).replace(/'/g, "''")
const psLiteral = (value) => `'${quote(resolve(value))}'`

const argv = process.argv.slice(2)
let previewPath
if (argv[0] === '--preview') {
  previewPath = resolve(here('..'), argv[1] ?? 'preview.png')
  argv.splice(0, 2)
}

const heading = argv[0] || '任务完成'
const title = argv[1] || '《修 bug 与回归测试》'
const duration = argv[2] || '用时 2 分 05 秒'
const turnCost = argv[3] || '¥0.0042'
const todayCost = argv[4] || '¥1.2836'

let script = readFileSync(cardPath, 'utf8')
  .replace('@@HEADING@@', quote(heading))
  .replace('@@TITLE@@', quote(title))
  .replace('@@DURATION@@', quote(duration))
  .replace('@@TURN_COST@@', quote(turnCost))
  .replace('@@TODAY_COST@@', quote(todayCost))
  .replace('@@AUTO_CLOSE_MS@@', '6000')
  .replace('@@SKIP_IF_FOREGROUND@@', process.env.TURN_NOTIFIER_SKIP_FOREGROUND ?? '0')

const faceAnchor = '$ink.Dispose()'
const formAnchor = '$card = New-Object System.Windows.Forms.Form'
if (!script.includes(faceAnchor) || !script.includes(formAnchor)) {
  console.error('card script changed shape; update this tool')
  process.exit(1)
}

if (previewPath) {
  const withSaver = script.replace(
    faceAnchor,
    `${faceAnchor}\n$face.Save(${psLiteral(previewPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
  )
  script = withSaver.slice(0, withSaver.indexOf(formAnchor))
} else {
  const capture = `
$probeTimer = New-Object System.Windows.Forms.Timer
$probeTimer.Interval = 1200
$probeTimer.Add_Tick({
  $probeTimer.Stop()
  Add-Type -AssemblyName System.Drawing
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $probe = New-Object System.Drawing.Bitmap 900, 420
  $probeGraphics = [System.Drawing.Graphics]::FromImage($probe)
  $probeGraphics.CopyFromScreen($area.Right - 900, $area.Bottom - 420, 0, 0, $probe.Size)
  $probe.Save('${shotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
  $probeGraphics.Dispose()
  $probe.Dispose()
})
$card.Add_Shown({ $probeTimer.Start() })
`
  script = script.replace(
    '[System.Windows.Forms.Application]::Run()',
    `${capture}\n[System.Windows.Forms.Application]::Run()`,
  )
}

// Same hand-over as the plugin: a command line is too short for the script once
// it is base64 encoded, so it travels through a UTF-8 (BOM) temp file.
const scriptPath = join(tmpdir(), `turn-notifier-selftest-${process.pid}-${Date.now()}.ps1`)
writeFileSync(scriptPath, `﻿${script}`, 'utf8')
const bootstrap =
  `$path = '${scriptPath}'; ` +
  `$code = Get-Content -LiteralPath $path -Raw -Encoding UTF8; ` +
  `Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; ` +
  'Invoke-Expression $code'

if (previewPath) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', bootstrap], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    console.error(result.stderr || 'preview failed')
    process.exit(1)
  }
  console.log('preview', previewPath)
} else {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', bootstrap],
    { stdio: 'ignore', windowsHide: true },
  )
  child.on('error', (error) => console.error('spawn failed', error.message))
  console.log('spawned', child.pid)
  setTimeout(() => {
    console.log('done', shotPath)
  }, 5000)
}
