/**
 * Turn cost accounting for dsh-turn-notifier.
 *
 * DSH reports token usage for every model request (see the token-meter
 * package), but it has no notion of money: the provider catalog carries no
 * per-model price and the account API only exposes wallet balances. So the yuan
 * figure is computed here from the provider-reported token buckets multiplied by
 * the published price table, and the daily total is a ledger this plugin keeps
 * for itself.
 *
 * Everything in this module is pure: the host half feeds it session events and
 * it hands back the amounts to draw on the card. That keeps it testable offline.
 */

/**
 * Prices in CNY per one million tokens, taken from the public DeepSeek price
 * list. `peak` applies during Beijing business hours (Mon–Fri 09:00–12:00 and
 * 14:00–18:00); every other hour, weekend and holiday is billed at `offPeak`.
 *
 * @type {Record<string, {cacheHit: {peak: number, offPeak: number}, cacheMiss: {peak: number, offPeak: number}, output: {peak: number, offPeak: number}}>}
 */
export const PRICES = {
  'deepseek-flash': {
    cacheHit: { peak: 0.04, offPeak: 0.02 },
    cacheMiss: { peak: 2, offPeak: 1 },
    output: { peak: 8, offPeak: 4 },
  },
  'deepseek-v4-pro': {
    cacheHit: { peak: 0.3, offPeak: 0.15 },
    cacheMiss: { peak: 9, offPeak: 4.5 },
    output: { peak: 27, offPeak: 13.5 },
  },
}

/** The route the plugin assumes when an attempt reports no model at all. */
export const FALLBACK_MODEL = 'deepseek-flash'

const TOKENS_PER_PRICE_UNIT = 1_000_000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** Micro-yuan, the unit the ledger is stored in: integers stay exact in JSON. */
const MICRO_PER_YUAN = 1_000_000

/** Provider model ids may carry a date suffix: `deepseek-v4-pro-0813`. */
export function resolveModel(model) {
  const raw = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (!raw) return undefined
  if (Object.hasOwn(PRICES, raw)) return raw
  // Longest matching key wins, so a future key cannot shadow a shorter prefix.
  let best
  for (const key of Object.keys(PRICES)) {
    if (raw.startsWith(`${key}-`) && (best === undefined || key.length > best.length)) best = key
  }
  return best
}

/**
 * Beijing time of an epoch millisecond value, read off the UTC fields so the
 * host timezone never matters. China has no daylight saving time, so a fixed
 * offset is exact.
 */
function beijingParts(epochMs) {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS)
  return { weekday: shifted.getUTCDay(), hours: shifted.getUTCHours(), minutes: shifted.getUTCMinutes() }
}

/** `2026-11-25` in Beijing time, i.e. the ledger bucket of that instant. */
export function beijingDate(epochMs) {
  return new Date(epochMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * The provider bills at peak rate during Beijing business hours on weekdays.
 * Chinese statutory holidays are also off-peak, but no holiday calendar ships
 * with the plugin, so a holiday weekday is billed at peak rate.
 */
export function isPeakTime(epochMs) {
  const { weekday, hours, minutes } = beijingParts(epochMs)
  if (weekday === 0 || weekday === 6) return false
  const clock = hours * HOUR_MS + minutes * 60 * 1000
  return (clock >= 9 * HOUR_MS && clock < 12 * HOUR_MS) || (clock >= 14 * HOUR_MS && clock < 18 * HOUR_MS)
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export const toMicro = (yuan) => Math.round(count(yuan) * MICRO_PER_YUAN)

export const fromMicro = (micro) => count(micro) / MICRO_PER_YUAN

/**
 * Cost in CNY of one model request.
 *
 * A cache write is billed like a cache miss: the prompt still has to be read in
 * full, it merely leaves an entry behind for the next request.
 *
 * @param {{uncachedInputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, outputTokens?: number}} buckets
 * @param {{model?: string, time?: number}} options
 */
export function costOfBuckets(buckets, { model, time = Date.now() } = {}) {
  const price = PRICES[resolveModel(model) ?? FALLBACK_MODEL]
  const window = isPeakTime(time) ? 'peak' : 'offPeak'
  const missTokens = count(buckets?.uncachedInputTokens) + count(buckets?.cacheWriteTokens)
  return (
    count(buckets?.cacheReadTokens) * price.cacheHit[window] +
    missTokens * price.cacheMiss[window] +
    count(buckets?.outputTokens) * price.output[window]
  ) / TOKENS_PER_PRICE_UNIT
}

/**
 * Money as it appears on the card. A turn usually costs a fraction of a yuan, so
 * the number of decimals grows as the amount shrinks instead of rounding it away.
 */
export function formatYuan(yuan) {
  const value = count(yuan)
  if (!(value > 0)) return '¥0'
  const decimals = value < 0.01 ? 4 : value < 1 ? 3 : 2
  const text = value.toFixed(decimals)
  // A value that rounds to nothing still happened: say so instead of printing ¥0.
  return Number(text) === 0 ? '<¥0.0001' : `¥${text}`
}

/** The usage chunk is the last stream record that is never packed, so its time survives. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') {
      return { usage: record.chunk.usage, time: record.time }
    }
  }
  return undefined
}

/**
 * The provider-reported usage of the attempt an event closes, plus when it was
 * reported: `assistant/message` carries it directly, both message and attempt
 * keep the raw usage chunk in their stream. The two never both close the same
 * attempt, so billing whichever one shows up cannot double count.
 */
function usageOf(event) {
  const stream = lastStreamUsage(event.data?.stream)
  if (event.type === 'assistant/message') {
    const usage = event.data?.usage ?? stream?.usage
    return usage ? { usage, time: stream?.time } : undefined
  }
  return stream?.usage ? { usage: stream.usage, time: stream.time } : undefined
}

function newSessionState() {
  return { totalMicro: 0, slotKey: undefined, slotMicro: 0, model: undefined }
}

/**
 * Owns the money view of every session plus the daily ledger.
 *
 * The host half forwards durable session events and this class decides what an
 * event costs:
 *  - `request/header` records the model of the attempt that follows, because an
 *    attempt closed by `assistant/attempt` carries no message, hence no route;
 *  - `assistant/message` and `assistant/attempt` bill one request attempt;
 *  - `llm/retry-started` reopens a settled attempt, so the retried request is
 *    billed on top of the failed one instead of replacing it;
 *  - a repeated report of the same attempt (same turn and step) replaces the
 *    earlier contribution rather than adding to it, and an identical repeat is
 *    dropped, so a duplicated event can never double bill.
 */
export class CostTracker {
  /** @param {{now?: () => number}} [options] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    /** @type {Map<string, ReturnType<typeof newSessionState>>} */
    this.sessions = new Map()
    /** @type {Map<string, number>} beijing date -> micro-yuan spent, across all sessions */
    this.days = new Map()
  }

  stateFor(sessionId) {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = newSessionState()
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** Micro-yuan spent by one session since the plugin started watching it. */
  sessionMicro(sessionId) {
    return this.sessions.get(sessionId)?.totalMicro ?? 0
  }

  /** Micro-yuan spent on one Beijing day, across every session. */
  dayMicro(date = beijingDate(this.now())) {
    return this.days.get(date) ?? 0
  }

  /** Seed the ledger from persisted days (micro-yuan already known to be spent). */
  seedDays(days) {
    for (const [date, micro] of Object.entries(days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const value = Math.round(count(micro))
      if (value > 0) this.days.set(date, value)
    }
  }

  /** Forget what one day is known to have cost, so it can be recomputed. */
  resetDay(date = beijingDate(this.now())) {
    this.days.delete(date)
  }

  /** The days map as it should be persisted, trimmed to the most recent `keep` days. */
  snapshotDays(keep = 60) {
    const entries = [...this.days.entries()]
      .filter(([, micro]) => micro > 0)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const kept = entries.slice(Math.max(0, entries.length - keep))
    return Object.fromEntries(kept)
  }

  reportOf(event, sessionModel) {
    const data = event.data ?? {}
    const found = usageOf(event)
    if (!found) return undefined
    const usage = found.usage
    if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return undefined

    const source = event.type === 'assistant/message' ? data.message?.source : undefined
    const model = [source?.model, sessionModel, usage.model].find(
      (candidate) => typeof candidate === 'string' && candidate.length > 0,
    )
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    const step = typeof data.step === 'number' ? data.step : undefined
    return {
      key: turn === undefined || step === undefined ? undefined : `${turn}:${step}`,
      buckets: {
        uncachedInputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
      },
      model,
      // The usage chunk carries the instant the provider reported the usage,
      // which is the instant it is billed at. A report without a stream falls
      // back to the durable event time and only then to the wall clock.
      time: Number.isFinite(found.time) ? found.time : Number.isFinite(event.time) ? event.time : this.now(),
    }
  }

  /**
   * Feed one durable session event.
   *
   * @param {string} sessionId
   * @param {{type?: string, time?: number, data?: any}} event
   * @returns {{micro: number, model: string} | undefined} the cost of a newly
   *   billed attempt, `undefined` when the event carried no billable usage or
   *   only repeated a report that was already counted
   */
  ingest(sessionId, event) {
    if (!event || typeof event.type !== 'string') return undefined
    const state = this.stateFor(sessionId)
    const data = event.data ?? {}

    if (event.type === 'request/header') {
      // The header nests the resolved route under `config`; older logs put the
      // model straight on the header, so both are read.
      const model = data.header?.config?.model ?? data.header?.model
      if (typeof model === 'string' && model.length > 0) state.model = model
      return undefined
    }

    if (event.type === 'llm/retry-started') {
      // The retried request is billed on top of the failed one, so the slot that
      // would have absorbed it as a replacement is cleared.
      state.slotKey = undefined
      state.slotMicro = 0
      return undefined
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined

    const report = this.reportOf(event, state.model)
    if (!report) return undefined
    const micro = toMicro(costOfBuckets(report.buckets, { model: report.model, time: report.time }))
    if (micro <= 0) return undefined

    let delta = micro
    if (report.key !== undefined && state.slotKey === report.key) {
      if (state.slotMicro === micro) return undefined
      delta = micro - state.slotMicro
      state.slotMicro = micro
    } else if (report.key !== undefined) {
      state.slotKey = report.key
      state.slotMicro = micro
    }

    state.totalMicro += delta
    const date = beijingDate(report.time)
    this.days.set(date, (this.days.get(date) ?? 0) + delta)
    const model = resolveModel(report.model) ?? FALLBACK_MODEL
    return { micro, model }
  }
}

/**
 * One running window of one session, priced.
 *
 * The card reports what the window that just ended cost, so the meter keeps the
 * session total at the moment the window opened and hands back the growth when
 * it closes. Cost is monotonic per session, which makes the difference exact
 * even when the window covers several turns (a queued follow-up message) and
 * even when a subagent spent part of it.
 */
export class TurnMeter {
  /** @param {{now?: () => number}} [options] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.tracker = new CostTracker({ now })
    /** @type {Map<string, number>} sessionId -> micro-yuan already spent when the window opened */
    this.baselineMicro = new Map()
    /** @type {Map<string, number>} sessionId -> epoch ms when the window opened */
    this.startedAt = new Map()
  }

  /** Whether the session counts as running, i.e. whether a window is open. */
  isRunning(sessionId) {
    return this.baselineMicro.has(sessionId)
  }

  /** Bill one durable session event. Returns the newly billed amount, if any. */
  ingest(sessionId, event) {
    return this.tracker.ingest(sessionId, event)
  }

  seedDays(days) {
    this.tracker.seedDays(days)
  }

  resetDay(date) {
    this.tracker.resetDay(date)
  }

  snapshotDays(keep) {
    return this.tracker.snapshotDays(keep)
  }

  /** Micro-yuan spent in one session since this plugin started watching it. */
  sessionMicro(sessionId) {
    return this.tracker.sessionMicro(sessionId)
  }

  /** Micro-yuan spent today, i.e. the card's 今日累计. */
  todayMicro() {
    return this.tracker.dayMicro(beijingDate(this.now()))
  }

  /**
   * Open a window. Repeating the call while a window is open is a no-op, so a
   * duplicated running event cannot reset the baseline and lose the cost.
   *
   * @returns {boolean} whether a new window was opened
   */
  start(sessionId) {
    if (this.baselineMicro.has(sessionId)) return false
    this.baselineMicro.set(sessionId, this.tracker.sessionMicro(sessionId))
    this.startedAt.set(sessionId, this.now())
    return true
  }

  /**
   * Close a window.
   *
   * @returns {{elapsedMs: number, spentMicro: number} | undefined} what the
   *   window cost and how long it took, or `undefined` when none was open
   */
  finish(sessionId) {
    if (!this.baselineMicro.has(sessionId)) return undefined
    const baseline = this.baselineMicro.get(sessionId)
    const startedAt = this.startedAt.get(sessionId)
    this.baselineMicro.delete(sessionId)
    this.startedAt.delete(sessionId)
    const elapsedMs = typeof startedAt === 'number' ? Math.max(0, this.now() - startedAt) : 0
    return { elapsedMs, spentMicro: Math.max(0, this.tracker.sessionMicro(sessionId) - baseline) }
  }

  /** Forget the open windows of sessions that are gone. */
  forget(sessionId) {
    this.baselineMicro.delete(sessionId)
    this.startedAt.delete(sessionId)
  }
}

