// End-to-end replay of the host half against a real Session log.
//
//   node dev/host-replay.mjs [session.v4.jsonl.zstd] [--quiet] [--backfill]
//
// Without a path it picks the newest log under ~/.dsh/sessions. The log only
// holds durable events, so the replay synthesizes what the Host emits around
// them: the Session starts running before the first event and stops after the
// last one. Everything else — the accounting, the ledger, the wording and the
// card itself — is the plugin's own code, with a throwaway ledger so the
// machine's real daily total is not touched.
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decompressFrames, findLatestSessionLog, parseRecords } from '../lib/log-frames.js'

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
// --backfill replays nothing itself: it lets the plugin's own startup backfill
// read this machine's logs, which is what a fresh DSH start does.
const backfill = args.includes('--backfill')
const path = backfill ? undefined : (args.find((value) => !value.startsWith('--')) ?? findLatestSessionLog())
if (!path && !backfill) {
  console.error('找不到会话日志；请显式传一个 session.v4.jsonl.zstd 的路径')
  process.exit(1)
}

// The ledger path is read when index.js is imported, so it is set first. The
// startup backfill is disabled: this replay feeds exactly one log, and reading
// the machine's logs on top of that would bill the same requests twice.
const ledgerDirectory = join(tmpdir(), `turn-notifier-replay-${process.pid}`)
const ledgerPath = join(ledgerDirectory, 'usage.json')
process.env.TURN_NOTIFIER_LEDGER = ledgerPath
if (!backfill) process.env.TURN_NOTIFIER_BACKFILL = '0'

const events = backfill ? [] : parseRecords(await decompressFrames(readFileSync(path)))
const sessionId = events.find((event) => event.type === 'session')?.id ?? 'replay'
const billable = events.filter((event) => event.type !== 'session')
if (backfill) console.log('no replay: letting the plugin own backfill run')
else console.log(`replaying ${billable.length} events from ${sessionId}`)

const replay = async () => {
  // A minimal Host stand-in: the plugin only uses `ctx.on`, `ctx.effect`, `ctx.get`.
  const listeners = new Map()
  const emit = (type, ...payload) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(...payload)
  }
  const ctx = {
    on(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
      return () => set.delete(listener)
    },
    effect(setup) {
      return setup()
    },
    get() {
      return undefined
    },
  }

  const { apply } = await import('../index.js')
  const dispose = apply(ctx)
  if (!quiet) console.log('')

  if (!backfill) {
    emit('api-session/status', sessionId, true)
    for (const event of billable) emit('session/event', { id: sessionId }, event)
    emit('api-session/status', sessionId, false)
  }

  // The report reads a title asynchronously, and the startup backfill finishes
  // when the logs are read, so poll the ledger instead of guessing a duration.
  const deadline = Date.now() + (backfill ? 30_000 : 5_000)
  const ledger = () => {
    try {
      return JSON.parse(readFileSync(ledgerPath, 'utf8'))
    } catch {
      return undefined
    }
  }
  let current = ledger()
  while (Date.now() < deadline) {
    if (current && Object.keys(current.days ?? {}).length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 200))
    current = ledger()
  }
  if (current) console.log(`ledger ${ledgerPath} -> ${JSON.stringify(current)}`)
  else console.log('ledger not written')
  dispose?.()
  rmSync(ledgerDirectory, { recursive: true, force: true })
}

await replay()
// The card may still hold the process open; the replay is done either way.
process.exit(0)
