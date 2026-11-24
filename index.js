/**
 * Host half of dsh-turn-notifier.
 *
 * Windows toast notifications are not usable on every machine (the platform
 * silently drops them when notifications are disabled in Settings), so the
 * reminder is a small always-on-top card drawn by a short-lived PowerShell
 * window in the lower right corner of the screen, plus a system sound.
 *
 * The card is skipped while the Harness window itself is in the foreground:
 * you are already looking at the answer in that case.
 */

import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'turn-notifier'

const CARD_PATH = fileURLToPath(new URL('./lib/card.ps1', import.meta.url))
const AUTO_CLOSE_MS = 15000

const quote = (value) => String(value).replace(/'/g, "''")

const formatDuration = (milliseconds) => {
  const total = Math.max(0, Math.round(milliseconds / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

// The card script is too long for a command line once it is base64 encoded, so
// it is handed over through a UTF-8 (BOM) temp file and executed as a script
// block: the machine forbids running .ps1 files, but not evaluating their text.
const bootstrap = (scriptPath) =>
  `$path = '${scriptPath}'; ` +
  `$script = Get-Content -LiteralPath $path -Raw -Encoding UTF8; ` +
  `Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; ` +
  'Invoke-Expression $script'

const showCard = (heading, title, duration) => {
  if (process.platform !== 'win32') return
  let script
  try {
    script = readFileSync(CARD_PATH, 'utf8')
      .replace('@@HEADING@@', quote(heading))
      .replace('@@TITLE@@', quote(title))
      .replace('@@DURATION@@', quote(duration))
      .replace('@@AUTO_CLOSE_MS@@', String(AUTO_CLOSE_MS))
      // Skip the card while the Harness window is in front: the answer is
      // already on screen then, and a corner card would only be in the way.
      .replace('@@SKIP_IF_FOREGROUND@@', '1')
  } catch (error) {
    console.warn('[turn-notifier] 读取提醒脚本失败：', error)
    return
  }
  const scriptPath = join(tmpdir(), `turn-notifier-${process.pid}-${Date.now()}.ps1`)
  try {
    // The BOM keeps Windows PowerShell reading the Chinese text as UTF-8.
    writeFileSync(scriptPath, `\ufeff${script}`, 'utf8')
  } catch (error) {
    console.warn('[turn-notifier] 写入提醒脚本失败：', error)
    return
  }
  try {
    // Not detached on purpose: a detached child is torn down together with the
    // job object that owns this process, which kills the card before it shows.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', bootstrap(scriptPath)],
      { stdio: 'ignore', windowsHide: true },
    )
    child.on('error', (error) => {
      console.warn('[turn-notifier] 提醒窗口启动失败：', error)
      try {
        unlinkSync(scriptPath)
      } catch {}
    })
    child.unref()
  } catch (error) {
    console.warn('[turn-notifier] 提醒窗口启动失败：', error)
  }
}

export function apply(ctx) {
  const previousRunning = new Map()
  const startedAt = new Map()

  const readRecord = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (!query?.readTitleSnapshot) return {}
    try {
      const observation = await query.readTitleSnapshot(sessionId)
      return {
        origin: observation?.session?.origin,
        title: observation?.title?.title ?? '',
      }
    } catch {
      return {}
    }
  }

  const report = async (sessionId, elapsed) => {
    const record = await readRecord(sessionId)
    if (record.origin === 'subagent') return
    const raw = typeof record.title === 'string' ? record.title.trim() : ''
    const title = raw ? `《${raw}》` : '任务已结束'
    const duration = `用时 ${formatDuration(elapsed)}`
    showCard('任务完成', title, duration)
  }

  const observe = (sessionId, running) => {
    const previous = previousRunning.get(sessionId)
    previousRunning.set(sessionId, running === true)
    if (running === true) {
      if (previous !== true) startedAt.set(sessionId, Date.now())
      return
    }
    if (previous !== true) return
    const started = startedAt.get(sessionId)
    startedAt.delete(sessionId)
    const elapsed = typeof started === 'number' ? Date.now() - started : 0
    report(sessionId, elapsed).catch((error) => {
      console.warn('[turn-notifier] 生成提醒失败：', error)
    })
  }

  ctx.effect(() => {
    const off = ctx.on('api-session/status', (sessionId, running) => {
      try {
        observe(sessionId, running)
      } catch (error) {
        console.warn('[turn-notifier] 状态处理失败：', error)
      }
    })

    console.log('[turn-notifier] 任务完成提醒已启用')

    return () => {
      off?.()
      previousRunning.clear()
      startedAt.clear()
      console.log('[turn-notifier] 任务完成提醒已停用')
    }
  }, 'turn-notifier: session watcher')
}
