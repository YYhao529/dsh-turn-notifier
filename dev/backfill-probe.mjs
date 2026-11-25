// Times the startup backfill against this machine's real logs and prints what it
// rebuilds for today. Development aid: it reads the real `~/.dsh/sessions` but
// keeps its accounting in memory, so no ledger is touched.
import { backfillToday } from '../lib/backfill.js'
import { CostTracker, beijingDate, formatYuan, fromMicro } from '../lib/cost.js'

const tracker = new CostTracker()
const started = Date.now()
const result = await backfillToday({
  ingest: (sessionId, event) => tracker.ingest(sessionId, event),
  onError: (path, error) => console.warn('failed', path, error.message),
})
const elapsed = Date.now() - started
const today = beijingDate(Date.now())
console.log(
  `logs ${result.logs}  events ${result.events}  failed ${result.failed}  ` +
    `${formatYuan(fromMicro(tracker.dayMicro(today)))} in ${elapsed} ms`,
)
