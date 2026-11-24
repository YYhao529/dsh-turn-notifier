/**
 * Client half of dsh-turn-notifier.
 *
 * The reminder itself is produced by the host half (a desktop card in the lower
 * right corner of the screen, see lib/card.ps1). This half only adds a second,
 * zero-cost hint for the case where the Harness window is minimised: it marks
 * the document title so the taskbar entry shows a bell until you come back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-notifier',
  factory(require) {
    const module = { exports: {} }

    const TITLE_MARK = '🔔 任务完成'

    module.exports = {
      name: 'turn-notifier',
      inject: ['sessions', 'remote'],
      apply,
    }

    function apply(ctx) {
      ctx.effect(() => {
        let originalTitle
        let marked = false
        const previousRunning = new Map()

        const markTitle = () => {
          if (marked) return
          if (typeof document === 'undefined') return
          if (document.hidden !== true) return
          if (typeof document.title !== 'string') return
          originalTitle = document.title
          document.title = TITLE_MARK
          marked = true
        }

        const restoreTitle = () => {
          if (!marked) return
          if (typeof document.title !== 'string') return
          document.title = originalTitle
          marked = false
        }

        const sessionRow = (sessionId) => {
          try {
            const list = ctx.sessions?.list?.getSnapshot?.()
            return list?.byId?.[sessionId]
          } catch {
            return undefined
          }
        }

        const observe = (sessionId, running) => {
          const previous = previousRunning.get(sessionId)
          previousRunning.set(sessionId, running === true)
          if (running === true) return
          if (previous !== true) return
          if (sessionRow(sessionId)?.origin === 'subagent') return
          markTitle()
        }

        const offStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
          try {
            observe(sessionId, running)
          } catch (error) {
            console.warn('[turn-notifier] 状态处理失败：', error)
          }
        })

        // Baseline: sessions already running when this module loads must not be
        // reported as finished by their first idle event.
        try {
          const list = ctx.sessions?.list?.getSnapshot?.()
          for (const [sessionId, row] of Object.entries(list?.byId ?? {})) {
            previousRunning.set(sessionId, row?.running === true)
          }
        } catch {
          // nothing to baseline
        }

        const onFocus = () => restoreTitle()
        if (typeof window !== 'undefined') {
          window.addEventListener('focus', onFocus)
          window.addEventListener('pointerdown', onFocus)
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onFocus)
        }

        console.log('[turn-notifier] 任务完成提醒已启用')

        return () => {
          offStatus?.()
          previousRunning.clear()
          restoreTitle()
          if (typeof window !== 'undefined') {
            window.removeEventListener('focus', onFocus)
            window.removeEventListener('pointerdown', onFocus)
          }
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onFocus)
          }
          console.log('[turn-notifier] 任务完成提醒已停用')
        }
      }, 'turn-notifier: title mark')
    }

    return module.exports
  },
})
