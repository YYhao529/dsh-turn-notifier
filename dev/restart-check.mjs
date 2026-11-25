// Simulates two DSH restarts against the same ledger and checks that the startup
// backfill adds today's cost exactly once. Uses a temp ledger path, so the real
// `data/usage.json` is never touched.
//
//   node dev/restart-check.mjs
//
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = mkdtempSync(join(tmpdir(), 'turn-notifier-restart-'))
const ledgerPath = join(directory, 'usage.json')
process.env.TURN_NOTIFIER_LEDGER = ledgerPath
delete process.env.TURN_NOTIFIER_BACKFILL

/** The parts of a Cordis context the host half uses. */
const fakeContext = () => {
  const listeners = new Map()
  let disposer
  return {
    on(type, handler) {
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
      return () => set.delete(handler)
    },
    effect(setup) {
      disposer = setup()
      return () => disposer?.()
    },
    get() {
      return undefined
    },
    dispose() {
      disposer?.()
    },
  }
}

const settle = async () => {
  const deadline = Date.now() + 30_000
  let stamp
  try {
    stamp = statSync(ledgerPath).mtimeMs
  } catch {
    stamp = 0
  }
  while (Date.now() < deadline) {
    try {
      if (statSync(ledgerPath).mtimeMs !== stamp) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    return JSON.parse(readFileSync(ledgerPath, 'utf8'))
  } catch {
    return undefined
  }
}

const once = async (index) => {
  const { apply } = await import(index)
  const ctx = fakeContext()
  apply(ctx)
  const ledger = await settle()
  ctx.dispose()
  return ledger
}

const index = pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href
const first = await once(index)
const second = await once(index)

console.log('first restart  ', JSON.stringify(first))
console.log('second restart ', JSON.stringify(second))

const days = (ledger) => Object.keys(ledger?.days ?? {})
const same =
  days(first).length === days(second).length &&
  days(first).every((day) => Math.abs((first.days[day] ?? 0) - (second.days[day] ?? 0)) <= 1)
console.log(same ? 'ok：重启不会把今天的钱算两遍' : 'FAIL：两次重启的账本不一致')
rmSync(directory, { recursive: true, force: true })
process.exit(same ? 0 : 1)
