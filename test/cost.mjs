/**
 * Offline checks for the money model behind the card (lib/cost.js).
 *
 * Nothing here needs a Host: the events are built by hand, in the exact shape
 * the durable Session log carries, so a regression in the pricing or in the
 * duplicate-report handling fails before it can show a wrong amount.
 */
import assert from 'node:assert/strict'
import {
  CostTracker,
  FALLBACK_MODEL,
  PRICES,
  TurnMeter,
  beijingDate,
  costOfBuckets,
  formatYuan,
  fromMicro,
  isPeakTime,
  resolveModel,
  toMicro,
} from '../lib/cost.js'

let passed = 0
const failures = []

function check(name, run) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

/** Epoch ms of a Beijing wall-clock time, independent of the host timezone. */
const beijing = (text) => Date.parse(`${text}+08:00`)

const PEAK = beijing('2026-11-25T10:00:00') // Wednesday, morning peak window
const OFF_PEAK = beijing('2026-11-25T20:00:00') // same Wednesday, evening

/** One assistant message carrying provider usage, as the log records it. */
function message({ turn = 1, step = 1, usage, model = 'deepseek-flash', time = PEAK, streamTime } = {}) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      message: { source: { provider: 'deepseek-official', model } },
      stream: streamTime === undefined
        ? []
        : [{ type: 'chunk', time: streamTime, chunk: { type: 'usage', usage } }],
      usage,
    },
  }
}

const buckets = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
})

/**
 * What the tracker should charge for one provider usage report, in micro-yuan.
 *
 * `costOfBuckets` takes the cost-side bucket names, where `inputTokens` is the
 * uncached remainder (`prompt_tokens - cache_read - cache_write`), so the
 * provider shape has to be translated the same way the tracker does it.
 */
const expectedMicro = (usage, { model, time = PEAK } = {}) =>
  toMicro(
    costOfBuckets(
      {
        uncachedInputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
      },
      { model, time },
    ),
  )

console.log('model prices')

check('价格表覆盖两个已发布模型', () => {
  assert.deepEqual(Object.keys(PRICES).sort(), ['deepseek-flash', 'deepseek-v4-pro'])
})

check('模型 id 上的大小写与日期后缀归一到价格表条目', () => {
  assert.equal(resolveModel('deepseek-flash'), 'deepseek-flash')
  assert.equal(resolveModel('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
  assert.equal(resolveModel('  DeepSeek-V4-Pro  '), 'deepseek-v4-pro')
  assert.equal(resolveModel('deepseek-flash-1017'), 'deepseek-flash')
  assert.equal(resolveModel('deepseeker'), undefined)
  assert.equal(resolveModel('gpt-4o'), undefined)
  assert.equal(resolveModel(undefined), undefined)
})

check('高峰时段按百万 token 计价', () => {
  const price = (buckets, model) => costOfBuckets(buckets, { model, time: PEAK })
  // flash peak: 未命中 2 / 命中 0.04 / 输出 8
  assert.equal(price({ uncachedInputTokens: 1_000_000 }, 'deepseek-flash'), 2)
  assert.equal(price({ cacheReadTokens: 1_000_000 }, 'deepseek-flash'), 0.04)
  assert.equal(price({ outputTokens: 1_000_000 }, 'deepseek-flash'), 8)
  // v4-pro peak: 未命中 9 / 命中 0.3 / 输出 27
  assert.equal(price({ uncachedInputTokens: 1_000_000 }, 'deepseek-v4-pro'), 9)
  assert.equal(price({ cacheReadTokens: 1_000_000 }, 'deepseek-v4-pro'), 0.3)
  assert.equal(price({ outputTokens: 1_000_000 }, 'deepseek-v4-pro'), 27)
})

check('错峰时段是高峰的一半', () => {
  const all = { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }
  const peak = costOfBuckets(all, { model: 'deepseek-flash', time: PEAK })
  const offPeak = costOfBuckets(all, { model: 'deepseek-flash', time: OFF_PEAK })
  assert.equal(peak, 2 + 0.04 + 8)
  assert.equal(offPeak, peak / 2)
})

check('缓存写入按未命中计价', () => {
  const write = costOfBuckets({ cacheWriteTokens: 1_000_000 }, { model: 'deepseek-flash', time: PEAK })
  const miss = costOfBuckets({ uncachedInputTokens: 1_000_000 }, { model: 'deepseek-flash', time: PEAK })
  assert.equal(write, miss)
  assert.equal(write, 2)
})

check('未知模型按回退模型计价而不是报错', () => {
  const usage = { uncachedInputTokens: 1_000_000 }
  assert.equal(
    costOfBuckets(usage, { model: 'mystery-model', time: PEAK }),
    costOfBuckets(usage, { model: FALLBACK_MODEL, time: PEAK }),
  )
  assert.equal(costOfBuckets(usage, { time: PEAK }), costOfBuckets(usage, { model: FALLBACK_MODEL, time: PEAK }))
})

check('缺失或非法的 token 计数按 0 处理', () => {
  assert.equal(costOfBuckets(undefined, { time: PEAK }), 0)
  assert.equal(costOfBuckets({ uncachedInputTokens: -5, outputTokens: Number.NaN }, { time: PEAK }), 0)
})

console.log('\n北京时间与峰谷判定')

check('北京日期按 UTC+8 切分，与本机时区无关', () => {
  assert.equal(beijingDate(beijing('2026-11-25T10:00:00')), '2026-11-25')
  // 北京 00:30 已经是新的一天，而 UTC 还是前一天
  assert.equal(beijingDate(beijing('2026-11-26T00:30:00')), '2026-11-26')
  assert.equal(beijingDate(beijing('2026-11-25T23:30:00')), '2026-11-25')
})

check('工作日两个高峰窗口，边界含开始不含结束', () => {
  const wednesday = (clock) => isPeakTime(beijing(`2026-11-25T${clock}:00`))
  assert.equal(wednesday('08:59'), false)
  assert.equal(wednesday('09:00'), true)
  assert.equal(wednesday('11:59'), true)
  assert.equal(wednesday('12:00'), false)
  assert.equal(wednesday('13:59'), false)
  assert.equal(wednesday('14:00'), true)
  assert.equal(wednesday('17:59'), true)
  assert.equal(wednesday('18:00'), false)
  assert.equal(wednesday('21:00'), false)
})

check('周末全天错峰', () => {
  assert.equal(isPeakTime(beijing('2026-11-28T10:00:00')), false) // 周六
  assert.equal(isPeakTime(beijing('2026-11-29T15:00:00')), false) // 周日
})

console.log('\n金额格式')

check('金额小数位随量级变化，且不会把真实花费显示成 0', () => {
  assert.equal(formatYuan(0), '¥0')
  assert.equal(formatYuan(0.00001), '<¥0.0001')
  assert.equal(formatYuan(0.0042), '¥0.0042')
  assert.equal(formatYuan(0.1234), '¥0.123')
  assert.equal(formatYuan(1.2836), '¥1.28')
  assert.equal(formatYuan(12.4806), '¥12.48')
  assert.equal(formatYuan(undefined), '¥0')
})

check('微元换算保持整数精度', () => {
  assert.equal(toMicro(0.0042), 4200)
  assert.equal(fromMicro(4200), 0.0042)
  assert.equal(toMicro(fromMicro(1_583_523)), 1_583_523)
})

console.log('\n单次请求计费')

check('assistant/message 携带的 usage 计费一次', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  const billed = tracker.ingest('s1', message({ usage: buckets(19_437, 164) }))
  assert.ok(billed)
  assert.equal(billed.model, 'deepseek-flash')
  assert.equal(tracker.sessionMicro('s1'), expectedMicro(buckets(19_437, 164), { model: 'deepseek-flash' }))
  assert.equal(tracker.dayMicro('2026-11-25'), tracker.sessionMicro('s1'))
})

check('同一步骤重复上报不会重复计费', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  const event = message({ usage: buckets(1000, 100) })
  assert.ok(tracker.ingest('s1', event))
  const once = tracker.sessionMicro('s1')
  assert.equal(tracker.ingest('s1', event), undefined)
  assert.equal(tracker.sessionMicro('s1'), once)
})

check('同一步骤数值变化时替换而不是累加', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  tracker.ingest('s1', message({ usage: buckets(1000, 100) }))
  const first = tracker.sessionMicro('s1')
  tracker.ingest('s1', message({ usage: buckets(1000, 300) }))
  const replacement = expectedMicro(buckets(1000, 300), { model: 'deepseek-flash' })
  assert.equal(tracker.sessionMicro('s1'), replacement)
  assert.ok(replacement > first)
})

check('重试后同一 turn/step 的新一次请求累加', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  tracker.ingest('s1', message({ usage: buckets(1000, 100) }))
  const failed = tracker.sessionMicro('s1')
  tracker.ingest('s1', { type: 'llm/retry-started', time: PEAK, data: { turn: 1, step: 1 } })
  tracker.ingest('s1', message({ usage: buckets(1000, 400) }))
  const retried = expectedMicro(buckets(1000, 400), { model: 'deepseek-flash' })
  assert.equal(tracker.sessionMicro('s1'), failed + retried)
})

check('assistant/attempt 用流里的 usage 计费', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  const usage = buckets(2000, 200)
  const billed = tracker.ingest('s1', {
    type: 'assistant/attempt',
    time: PEAK,
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: PEAK, chunk: { type: 'usage', usage } }] },
  })
  assert.ok(billed)
  assert.equal(tracker.sessionMicro('s1'), expectedMicro(usage, { model: FALLBACK_MODEL }))
})

check('request/header 的模型用于其后没有 message 的请求', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  const usage = buckets(1_000_000, 0)
  tracker.ingest('s1', {
    type: 'request/header',
    time: PEAK,
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
  })
  tracker.ingest('s1', {
    type: 'assistant/attempt',
    time: PEAK,
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: PEAK, chunk: { type: 'usage', usage } }] },
  })
  assert.equal(tracker.sessionMicro('s1'), expectedMicro(usage, { model: 'deepseek-v4-pro' }))
  // 旧日志把 model 直接放在 header 上
  const legacy = new CostTracker({ now: () => PEAK })
  legacy.ingest('s2', { type: 'request/header', time: PEAK, data: { header: { model: 'deepseek-v4-pro' } } })
  assert.equal(legacy.stateFor('s2').model, 'deepseek-v4-pro')
})

check('没有 usage 的事件不计费', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  assert.equal(tracker.ingest('s1', { type: 'turn/start', time: PEAK, data: { turn: 1 } }), undefined)
  assert.equal(tracker.ingest('s1', { type: 'assistant/message', time: PEAK, data: { turn: 1, step: 1 } }), undefined)
  assert.equal(tracker.ingest('s1', { type: 'assistant/message', data: { usage: { inputTokens: 10 } } }), undefined)
  assert.equal(tracker.sessionMicro('s1'), 0)
})

check('按 usage 上报时刻决定峰谷价与账本日期', () => {
  const tracker = new CostTracker({ now: () => OFF_PEAK })
  const usage = buckets(1_000_000, 0)
  // 事件本身写在北京时间 23:50（仍是当天），usage 流块落在 00:10（次日错峰）
  tracker.ingest('s1', message({ usage, time: beijing('2026-11-25T23:50:00'), streamTime: beijing('2026-11-26T00:10:00') }))
  assert.equal(tracker.dayMicro('2026-11-26'), expectedMicro(usage, { model: 'deepseek-flash', time: beijing('2026-11-26T00:10:00') }))
  assert.equal(tracker.dayMicro('2026-11-25'), 0)
})

console.log('\n每日账本')

check('账本读写只保留最近若干天', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  tracker.seedDays({ '2026-11-24': 1000, '2026-11-25': 2000, 'not-a-date': 500, '2026-11-20': 0 })
  assert.equal(tracker.dayMicro('2026-11-24'), 1000)
  assert.equal(tracker.dayMicro('2026-11-25'), 2000)
  const snapshot = tracker.snapshotDays(1)
  assert.deepEqual(snapshot, { '2026-11-25': 2000 })
})

check('跨日累计互不干扰', () => {
  const tracker = new CostTracker({ now: () => PEAK })
  tracker.ingest('s1', message({ usage: buckets(1000, 100) }))
  const first = tracker.dayMicro('2026-11-25')
  tracker.ingest('s1', message({ turn: 2, step: 1, usage: buckets(1000, 100), time: beijing('2026-11-26T10:00:00') }))
  assert.equal(tracker.dayMicro('2026-11-25'), first)
  assert.equal(tracker.dayMicro('2026-11-26'), first)
})

console.log('\n运行窗口')

check('本次消耗是窗口期间的增量', () => {
  let now = PEAK
  const meter = new TurnMeter({ now: () => now })
  meter.ingest('s1', message({ usage: buckets(1000, 100) })) // 插件启动前就已消耗
  const before = meter.sessionMicro('s1')
  assert.equal(meter.start('s1'), true)
  now += 65_000
  meter.ingest('s1', message({ turn: 2, step: 1, usage: buckets(2000, 200) }))
  const finished = meter.finish('s1')
  assert.ok(finished)
  assert.equal(finished.elapsedMs, 65_000)
  assert.equal(finished.spentMicro, meter.sessionMicro('s1') - before)
  assert.equal(meter.todayMicro(), meter.sessionMicro('s1'))
})

check('重复的运行事件不会重置基线', () => {
  let now = PEAK
  const meter = new TurnMeter({ now: () => now })
  meter.start('s1')
  meter.ingest('s1', message({ usage: buckets(1000, 100) }))
  now += 10_000
  assert.equal(meter.start('s1'), false)
  const finished = meter.finish('s1')
  assert.ok(finished)
  assert.ok(finished.spentMicro > 0)
  assert.equal(finished.elapsedMs, 10_000)
})

check('没开窗口时结束不会误报', () => {
  const meter = new TurnMeter({ now: () => PEAK })
  assert.equal(meter.finish('s1'), undefined)
  meter.start('s1')
  meter.finish('s1')
  assert.equal(meter.finish('s1'), undefined)
})

check('连续两个窗口各算各的', () => {
  let now = PEAK
  const meter = new TurnMeter({ now: () => now })
  meter.start('s1')
  meter.ingest('s1', message({ usage: buckets(1000, 100) }))
  const first = meter.finish('s1')
  now += 1000
  meter.start('s1')
  meter.ingest('s1', message({ turn: 2, step: 1, usage: buckets(3000, 300) }))
  const second = meter.finish('s1')
  assert.ok(first && second)
  assert.equal(
    first.spentMicro + second.spentMicro,
    meter.sessionMicro('s1'),
    '两个窗口的花费应等于会话总额',
  )
  assert.ok(second.spentMicro > first.spentMicro)
})

check('今日累计包含重启前账本里的花费', () => {
  let now = PEAK
  const meter = new TurnMeter({ now: () => now })
  meter.seedDays({ '2026-11-25': 500_000 })
  assert.equal(meter.todayMicro(), 500_000)
  meter.start('s1')
  meter.ingest('s1', message({ usage: buckets(1000, 100) }))
  const finished = meter.finish('s1')
  assert.ok(finished)
  assert.equal(meter.todayMicro(), 500_000 + finished.spentMicro)
})

check('会话释放后窗口被清理', () => {
  const meter = new TurnMeter({ now: () => PEAK })
  meter.start('s1')
  assert.equal(meter.isRunning('s1'), true)
  meter.forget('s1')
  assert.equal(meter.isRunning('s1'), false)
  assert.equal(meter.finish('s1'), undefined)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
