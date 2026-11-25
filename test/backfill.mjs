// Offline tests for the startup backfill: today's logs are re-billed, older
// events are skipped, and a torn/undecodable log is counted instead of thrown.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { backfillToday, dshHome, findTodayLogs, startOfDay } from '../lib/backfill.js'
import { CostTracker, formatYuan, fromMicro } from '../lib/cost.js'
import { readLedger, writeLedger } from '../lib/ledger.js'

let passed = 0
let failed = 0
const check = async (label, run) => {
  try {
    await run()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label}`)
    console.log(String(error.stack ?? error).split('\n').slice(0, 4).map((line) => `      ${line}`).join('\n'))
  }
}

const beijing = (text) => Date.parse(`${text}+08:00`)
const PEAK = beijing('2026-11-25T10:00:00')
const TODAY_START = startOfDay(PEAK)

const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
  totalTokens: inputTokens + outputTokens + cacheReadTokens,
})

const message = (turn, step, time, model = 'deepseek-flash', tokens = usage(1000, 100)) => ({
  type: 'assistant/message',
  seq: turn * 10 + step,
  time,
  data: {
    turn,
    step,
    usage: tokens,
    message: { role: 'assistant', source: { provider: 'deepseek-official', model } },
    stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage: tokens } }],
  },
})

/** A log is written one zstd frame per flush; write it the same way. */
const writeLog = (path, records) => {
  mkdirSync(join(path, '..'), { recursive: true })
  const frames = records.map((record) => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')))
  writeFileSync(path, Buffer.concat(frames))
}

const sessionRecord = (id) => ({ type: 'session', version: 4, id })

console.log('backfill')

await check('本地午夜的毫秒数按本机时区算，且落在当天的 00:00', () => {
  const start = startOfDay(beijing('2026-11-25T16:20:00'))
  const date = new Date(start)
  assert.equal(date.getHours(), 0)
  assert.equal(date.getMinutes(), 0)
  assert.equal(date.getSeconds(), 0)
  assert.equal(date.getMilliseconds(), 0)
  assert.ok(start <= beijing('2026-11-25T16:20:00'))
  assert.ok(start > beijing('2026-11-24T23:59:59'))
})

await check('DSH_HOME 覆盖数据根目录，缺省是 ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: 'D:/data/dsh' }), 'D:/data/dsh')
  assert.match(dshHome({}), /\.dsh$/)
})

await check('只挑今天动过的会话日志', () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-notifier-backfill-'))
  try {
    writeLog(join(root, 'ws-a', 'session-1', 'session.v4.jsonl.zstd'), [sessionRecord('s1'), message(1, 1, PEAK)])
    writeLog(join(root, 'ws-b', 'session-2', 'session.v4.jsonl.zstd'), [sessionRecord('s2'), message(1, 1, PEAK)])
    const found = findTodayLogs({ root, since: TODAY_START })
    assert.equal(found.length, 2)
    assert.deepEqual(found.map((entry) => entry.sessionId).sort(), ['session-1', 'session-2'])
    // Nothing modified after the cutoff → nothing to re-bill.
    assert.equal(findTodayLogs({ root, since: Date.now() + 60_000 }).length, 0)
    // A root that does not exist is a no-op, not a crash.
    assert.deepEqual(findTodayLogs({ root: join(root, 'missing') }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('回放今天的日志会重建出与直接计价相同的金额', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-notifier-backfill-'))
  try {
    const records = [
      sessionRecord('s1'),
      message(1, 1, beijing('2026-11-25T09:30:00')),
      message(1, 2, beijing('2026-11-25T09:31:00'), 'deepseek-flash', usage(300, 116, 19_584)),
      message(1, 3, beijing('2026-11-25T13:10:00')), // 错峰，跨过 12:00
      message(2, 1, beijing('2026-11-25T14:05:00'), 'deepseek-v4-pro'),
    ]
    writeLog(join(root, 'ws-a', 'session-1', 'session.v4.jsonl.zstd'), records)

    const tracker = new CostTracker({ now: () => PEAK })
    const ingest = (sessionId, event) => tracker.ingest(sessionId, event)
    const result = await backfillToday({ root, now: PEAK, ingest })

    assert.equal(result.logs, 1)
    assert.equal(result.events, 4)
    assert.equal(result.failed, 0)
    // Same figure the live path would have produced for the same four requests.
    const expected = new CostTracker({ now: () => PEAK })
    for (const record of records.slice(1)) expected.ingest('s1', record)
    assert.equal(tracker.sessionMicro('s1'), expected.sessionMicro('s1'))
    assert.ok(tracker.sessionMicro('s1') > 0, '金额不应该为 0')
    assert.match(formatYuan(fromMicro(tracker.sessionMicro('s1'))), /^¥\d+\.\d+$/)
    assert.equal(tracker.dayMicro('2026-11-25'), tracker.sessionMicro('s1'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('昨天的事件不计入今天', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-notifier-backfill-'))
  try {
    writeLog(join(root, 'ws-a', 'session-1', 'session.v4.jsonl.zstd'), [
      sessionRecord('s1'),
      message(1, 1, beijing('2026-11-24T23:50:00')), // 昨天
      message(2, 1, beijing('2026-11-25T00:10:00')), // 今天凌晨，错峰
    ])
    const tracker = new CostTracker({ now: () => PEAK })
    const result = await backfillToday({ root, now: PEAK, ingest: (id, event) => tracker.ingest(id, event) })
    assert.equal(result.events, 1)
    assert.equal(tracker.dayMicro('2026-11-24'), 0)
    assert.ok(tracker.dayMicro('2026-11-25') > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('同一笔既回放又实时上报时只结算一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-notifier-backfill-'))
  try {
    const record = message(1, 1, PEAK)
    writeLog(join(root, 'ws-a', 'session-1', 'session.v4.jsonl.zstd'), [sessionRecord('s1'), record])
    const tracker = new CostTracker({ now: () => PEAK })
    // 实时先到，随后回放同一笔（重启瞬间就是这个顺序）。
    tracker.ingest('s1', record)
    const before = tracker.sessionMicro('s1')
    await backfillToday({ root, now: PEAK, ingest: (id, event) => tracker.ingest(id, event) })
    assert.equal(tracker.sessionMicro('s1'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('坏日志只记一笔失败，不影响其它日志', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-notifier-backfill-'))
  try {
    writeLog(join(root, 'ws-a', 'session-1', 'session.v4.jsonl.zstd'), [sessionRecord('s1'), message(1, 1, PEAK)])
    mkdirSync(join(root, 'ws-a', 'session-broken'), { recursive: true })
    writeFileSync(join(root, 'ws-a', 'session-broken', 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'))
    const seen = []
    const tracker = new CostTracker({ now: () => PEAK })
    const result = await backfillToday({
      root,
      now: PEAK,
      ingest: (id, event) => tracker.ingest(id, event),
      onError: (path) => seen.push(path),
    })
    assert.equal(result.logs, 2)
    assert.equal(result.events, 1)
    assert.equal(result.failed, 1)
    assert.equal(seen.length, 1)
    assert.ok(tracker.sessionMicro('s1') > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('没有日志目录时安静返回', async () => {
  const result = await backfillToday({ root: join(tmpdir(), 'definitely-missing-dsh-home'), now: PEAK, ingest: () => {} })
  assert.deepEqual(result, { logs: 0, events: 0, failed: 0 })
})

/** The bits of a Cordis context the host half touches. */
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
    emit(type, ...args) {
      for (const handler of listeners.get(type) ?? []) handler(...args)
    },
    dispose() {
      disposer?.()
    },
  }
}

await check('账本里今天的数与日志重叠时只算一次（重启不翻倍）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'turn-notifier-startup-'))
  const ledgerPath = join(home, 'usage.json')
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    TURN_NOTIFIER_LEDGER: process.env.TURN_NOTIFIER_LEDGER,
    TURN_NOTIFIER_BACKFILL: process.env.TURN_NOTIFIER_BACKFILL,
  }
  let context
  try {
    const records = [
      sessionRecord('s1'),
      message(1, 1, PEAK),
      message(1, 2, PEAK, 'deepseek-flash', usage(300, 116, 19_584)),
    ]
    writeLog(join(home, 'sessions', 'ws-a', 'session-1', 'session.v4.jsonl.zstd'), records)

    // What the two requests cost, i.e. what both the log and the ledger hold.
    const once = new CostTracker({ now: () => PEAK })
    for (const record of records.slice(1)) once.ingest('s1', record)
    const single = once.dayMicro('2026-11-25')
    assert.ok(single > 0)
    // A ledger left behind by the previous run already counted those requests.
    writeLedger(ledgerPath, { '2026-11-25': single })

    process.env.DSH_HOME = home
    process.env.TURN_NOTIFIER_LEDGER = ledgerPath
    delete process.env.TURN_NOTIFIER_BACKFILL

    const { apply } = await import('../index.js')
    context = fakeContext()
    apply(context)

    // Wait for the plugin's own rewrite: the seeded ledger already holds `single`,
    // so only a changed file can tell the backfill has finished settling it.
    const stamp = statSync(ledgerPath).mtimeMs
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (statSync(ledgerPath).mtimeMs !== stamp) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const written = readLedger(ledgerPath).days['2026-11-25'] ?? 0
    assert.notEqual(statSync(ledgerPath).mtimeMs, stamp, '插件没有重新写过账本')
    assert.equal(written, single, '补记不应该把账本里已有的今天再算一遍')
  } finally {
    context?.dispose()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})


console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
