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
 *
 * Next to the turn duration the card reports money: what the turn just cost and
 * how much today has cost so far. DSH knows token counts but not prices, so the
 * yuan figures are computed here from the provider-reported token buckets (see
 * lib/cost.js) and the day total is a ledger this plugin keeps for itself in
 * `data/usage.json`.
 */

import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TurnMeter, formatYuan, fromMicro } from './lib/cost.js'
import { backfillToday } from './lib/backfill.js'
import { readLedger, writeLedger } from './lib/ledger.js'

export const name = 'turn-notifier'

const CARD_PATH = fileURLToPath(new URL('./lib/card.ps1', import.meta.url))
// `TURN_NOTIFIER_LEDGER` exists so the replay and test harnesses in `dev/` can
// bill a throwaway ledger instead of the machine's real daily total.
const LEDGER_PATH =
  process.env.TURN_NOTIFIER_LEDGER || fileURLToPath(new URL('./data/usage.json', import.meta.url))
const AUTO_CLOSE_MS = 15000
/** Cost arrives event by event; the ledger is rewritten at most this often. */
const LEDGER_FLUSH_MS = 4000

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

const showCard = (heading, title, duration, turnCost, todayCost) => {
  if (process.platform !== 'win32') return
  let script
  try {
    script = readFileSync(CARD_PATH, 'utf8')
      .replace('@@HEADING@@', quote(heading))
      .replace('@@TITLE@@', quote(title))
      .replace('@@DURATION@@', quote(duration))
      .replace('@@TURN_COST@@', quote(turnCost))
      .replace('@@TODAY_COST@@', quote(todayCost))
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
  const meter = new TurnMeter()
  meter.seedDays(readLedger(LEDGER_PATH).days)
  // The startup backfill recomputes today from the session logs, and those logs
  // already contain whatever the ledger says. Drop today's bucket before the
  // backfill starts reading so the two cannot be added together; everything the
  // backfill replays then lands exactly once, deduplicated by (turn, step).
  const backfill = process.env.TURN_NOTIFIER_BACKFILL !== '0'
  if (backfill) meter.resetDay()

  let flushTimer
  const flush = () => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    try {
      writeLedger(LEDGER_PATH, meter.snapshotDays())
    } catch (error) {
      console.warn('[turn-notifier] 保存当日消耗失败：', error)
    }
  }
  const scheduleFlush = () => {
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush()
    }, LEDGER_FLUSH_MS)
    // Never hold the host process open just to rewrite the ledger.
    flushTimer.unref?.()
  }

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

  const report = async (sessionId, elapsed, spentMicro) => {
    const record = await readRecord(sessionId)
    if (record.origin === 'subagent') return
    const raw = typeof record.title === 'string' ? record.title.trim() : ''
    const title = raw ? `《${raw}》` : '任务已结束'
    const duration = `用时 ${formatDuration(elapsed)}`
    const turnCost = formatYuan(fromMicro(spentMicro))
    const todayCost = formatYuan(fromMicro(meter.todayMicro()))
    console.log(`[turn-notifier] 本次消耗 ${turnCost}，今日累计 ${todayCost}`)
    showCard('任务完成', title, duration, turnCost, todayCost)
    // A finished turn is the natural checkpoint: persist now so the daily total
    // survives a crash instead of waiting for the debounced rewrite.
    flush()
  }

  const observe = (sessionId, running) => {
    if (running === true) {
      meter.start(sessionId)
      return
    }
    const finished = meter.finish(sessionId)
    if (!finished) return
    report(sessionId, finished.elapsedMs, finished.spentMicro).catch((error) => {
      console.warn('[turn-notifier] 生成提醒失败：', error)
    })
  }

  ctx.effect(() => {
    const offStatus = ctx.on('api-session/status', (sessionId, running) => {
      try {
        observe(sessionId, running)
      } catch (error) {
        console.warn('[turn-notifier] 状态处理失败：', error)
      }
    })

    // Durable session events carry the token usage of every model request,
    // including the ones a subagent makes: they are billed too, and only the
    // card itself is limited to the sessions the user talks to.
    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        if (meter.ingest(sessionId, event)) scheduleFlush()
      } catch (error) {
        console.warn('[turn-notifier] 计费失败：', error)
      }
    })

    const offDisposed = ctx.on('session/disposed', (session) => {
      const sessionId = session?.id
      if (typeof sessionId === 'string') meter.forget(sessionId)
    })

    console.log('[turn-notifier] 任务完成提醒已启用')

    // Re-bill the logs already written today so the first card after a restart
    // shows a real daily total rather than only what this process has seen.
    // Set `TURN_NOTIFIER_BACKFILL=0` to skip it (the replay harness does).
    if (process.env.TURN_NOTIFIER_BACKFILL !== '0') {
      void backfillToday({
        now: Date.now(),
        ingest: (sessionId, event) => {
          if (meter.ingest(sessionId, event)) scheduleFlush()
        },
        onError: (path, error) => {
          console.warn('[turn-notifier] 读取历史会话失败：', path, error?.message ?? error)
        },
      })
        .then(({ logs, events }) => {
          if (events === 0) return
          flush()
          console.log(
            `[turn-notifier] 补记今日已发生的消耗：${formatYuan(fromMicro(meter.todayMicro()))}` +
              `（${logs} 个日志 / ${events} 条事件）`,
          )
        })
        .catch((error) => {
          console.warn('[turn-notifier] 补记今日消耗失败：', error)
        })
    }

    return () => {
      offStatus?.()
      offEvent?.()
      offDisposed?.()
      flush()
      console.log('[turn-notifier] 任务完成提醒已停用')
    }
  }, 'turn-notifier: session watcher')
}
