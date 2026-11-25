// Replays one durable Session log through lib/cost.js.
//
//   node dev/session-probe.mjs [session.v4.jsonl.zstd] [--events] [--json]
//
// Without a path it picks the newest log under ~/.dsh/sessions. The log holds
// durable events, so what is printed here is exactly what the plugin would have
// billed for those requests — same price table, same peak/off-peak switch.
import { readFileSync } from 'node:fs'
import { CostTracker, costOfBuckets, formatYuan, fromMicro, beijingDate, isPeakTime } from '../lib/cost.js'
import { decompressFrames, findLatestSessionLog, parseRecords } from '../lib/log-frames.js'

const args = process.argv.slice(2)
const path = args.find((value) => !value.startsWith('--')) ?? findLatestSessionLog()
if (!path) {
  console.error('usage: node dev/session-probe.mjs [session.v4.jsonl.zstd] [--events] [--json]')
  process.exit(1)
}
const showEvents = args.includes('--events')
const asJson = args.includes('--json')

const events = parseRecords(await decompressFrames(readFileSync(path)))

const counts = new Map()
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)

const sessionId = events.find((event) => event.type === 'session')?.id ?? 'probe'
const billable = events.filter((event) => event.type !== 'session')
const tracker = new CostTracker()
for (const event of billable) tracker.ingest(sessionId, event)

if (asJson) {
  console.log(
    JSON.stringify(
      { session: sessionId, counts: Object.fromEntries(counts), totalMicro: tracker.sessionMicro(sessionId) },
      undefined,
      2,
    ),
  )
} else {
  console.log(`${path}`)
  console.log(`  session      ${sessionId}`)
  const stamped = billable.filter((event) => Number.isFinite(event.time))
  const stamp = (event) => (event ? new Date(event.time).toISOString() : '—')
  console.log(`  records      ${billable.length}`)
  console.log(`  first/last   ${stamp(stamped[0])} … ${stamp(stamped.at(-1))}`)
  console.log(`  total        ${formatYuan(fromMicro(tracker.sessionMicro(sessionId)))}`)
  const byType = [...counts.entries()].sort((left, right) => right[1] - left[1])
  console.log(`  events       ${byType.map(([type, count]) => `${type}×${count}`).join(', ')}`)

  const samples = events.filter((event) => event.type === 'assistant/message').slice(0, 3)
  for (const event of samples) {
    const usage = event.data?.usage
    const streamUsage = (event.data?.stream ?? []).filter(
      (record) => record?.type === 'chunk' && record.chunk?.type === 'usage',
    )
    console.log(
      `  message      ${JSON.stringify({
        turn: event.data?.turn,
        step: event.data?.step,
        model: event.data?.message?.source?.model,
        provider: event.data?.message?.source?.provider,
        usage: usage ?? null,
        streamUsageRecords: streamUsage.length,
        streamUsage: streamUsage.map((record) => ({ time: record.time, usage: record.chunk.usage })),
      })}`,
    )
    if (usage) {
      const time = streamUsage[0]?.time ?? event.time
      const cost = costOfBuckets(
        {
          uncachedInputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
        },
        { model: event.data?.message?.source?.model, time },
      )
      console.log(
        `  cost         ${formatYuan(cost)} (${isPeakTime(time) ? 'peak' : 'off-peak'} @ ${beijingDate(time)})`,
      )
    }
  }

  const headers = events.filter((event) => event.type === 'request/header').slice(0, 3)
  for (const event of headers) {
    const header = event.data?.header ?? {}
    console.log(
      `  header       ${JSON.stringify({
        model: header.config?.model,
        provider: header.config?.provider,
        reason: event.data?.reason,
      })}`,
    )
  }

  const attempts = events.filter((event) => event.type === 'assistant/attempt')
  console.log(`  attempts     ${attempts.length}`)
  if (showEvents) {
    for (const event of billable) console.log(`  ${event.seq} ${event.type} ${JSON.stringify(event.data).slice(0, 160)}`)
  }
}
