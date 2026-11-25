// Today's spend is a per-account number, but the only durable record of it is
// the session logs on disk: the Host keeps no daily total, and the platform has
// no "spend so far today" endpoint. So when the plugin starts — after a restart,
// mid-day — it re-bills the logs written today before it was running, instead of
// showing ¥0 until the next request happens to finish.
//
// Only logs touched today are read, and the events are fed through the same
// CostTracker as live events, so the per-(turn, step) de-duplication that
// protects live accounting protects the merge too: an event both replayed and
// delivered live still lands in the ledger exactly once.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decompressFrames, LOG_NAME, parseRecords } from './log-frames.js'

/** Local midnight for the day `now` falls in, as epoch milliseconds. */
export function startOfDay(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `$DSH_HOME` (or `~/.dsh`) — the Host's user-data root. */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

const list = (directory) => {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Every session log modified since local midnight.
 *
 * A log's mtime is the time of its last write, so a session that started
 * yesterday and is still running shows up today as well — which is what we want,
 * because its today events are billed today.
 */
export function findTodayLogs({ root = join(dshHome(), 'sessions'), since } = {}) {
  const found = []
  for (const workspace of list(root)) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    for (const session of list(workspacePath)) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      const path = join(workspacePath, session.name, LOG_NAME)
      try {
        const stats = statSync(path)
        if (since === undefined || stats.mtimeMs >= since) found.push({ path, sessionId: session.name })
      } catch {}
    }
  }
  return found
}

/**
 * Re-bill today's logged events.
 *
 * @param ingest - `(sessionId, event) => void`, usually `TurnMeter.ingest`.
 * @returns `{ logs, events, failed }` — how many logs were read, how many events
 *   were inside today, and how many logs could not be decoded (logged, not fatal:
 *   a log being written right now can be torn).
 */
export async function backfillToday({ root, now = Date.now(), ingest, onError } = {}) {
  const since = startOfDay(now)
  const logs = findTodayLogs({ root, since })
  let events = 0
  let failed = 0
  for (const log of logs) {
    try {
      const records = parseRecords(await decompressFrames(readFileSync(log.path)))
      const sessionId = records.find((record) => record.type === 'session')?.id ?? log.sessionId
      for (const record of records) {
        if (record.type === 'session') continue
        if (!Number.isFinite(record.time) || record.time < since) continue
        ingest(sessionId, record)
        events += 1
      }
    } catch (error) {
      failed += 1
      onError?.(log.path, error)
    }
  }
  return { logs: logs.length, events, failed }
}
