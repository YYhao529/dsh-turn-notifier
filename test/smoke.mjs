import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

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

// Minimal browser stand-in: the plugin only touches document.title, the hidden
// flag, focus visibility and window/document event listeners.
function makeDocument() {
  const listeners = new Map()
  const document = {
    title: 'DSH 会话',
    hidden: true,
    addEventListener(type, handler) {
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    dispatch(type) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type })
    },
    listenerCount() {
      let total = 0
      for (const set of listeners.values()) total += set.size
      return total
    },
  }
  return document
}

function boot({ rows = {}, document = makeDocument() } = {}) {
  const windowListeners = new Map()
  const window = {
    addEventListener(type, handler) {
      const set = windowListeners.get(type) ?? new Set()
      set.add(handler)
      windowListeners.set(type, set)
    },
    removeEventListener(type, handler) {
      windowListeners.get(type)?.delete(handler)
    },
    dispatch(type) {
      for (const handler of [...(windowListeners.get(type) ?? [])]) handler({ type })
    },
    listenerCount() {
      let total = 0
      for (const set of windowListeners.values()) total += set.size
      return total
    },
  }

  let factory
  const sandbox = {
    window: Object.assign(window, { __ModuleLoader__: { load: (definition) => { factory = definition.factory } } }),
    document,
    console: { log() {}, warn() {}, error() {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const statusHandlers = new Set()
  const listHandlers = new Set()
  const listSnapshot = { ids: Object.keys(rows), byId: rows, phase: 'ready' }
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => listSnapshot,
        subscribe: (handler) => {
          listHandlers.add(handler)
          return () => listHandlers.delete(handler)
        },
      },
    },
    remote: {
      $on(event, handler) {
        assert.equal(event, 'api-session/status')
        statusHandlers.add(handler)
        return () => statusHandlers.delete(handler)
      },
    },
    effect(run) {
      disposer = run()
      return disposer
    },
  }
  let disposer

  const exportsObject = factory(() => {
    throw new Error('client half must not require anything')
  })
  const dispose = exportsObject.apply(ctx)

  return {
    document,
    window,
    remaining: () => statusHandlers.size + listHandlers.size + window.listenerCount() + document.listenerCount(),
    status: (sessionId, running) => {
      for (const handler of [...statusHandlers]) handler(sessionId, running)
    },
    finish: (sessionId) => {
      for (const handler of [...statusHandlers]) handler(sessionId, true)
      for (const handler of [...statusHandlers]) handler(sessionId, false)
    },
    dispose: () => disposer(),
  }
}

check('inject 声明只依赖 sessions 与 remote', () => {
  assert.ok(source.includes("inject: ['sessions', 'remote']"))
})

check('后台结束时标题标记为任务完成', () => {
  const app = boot()
  app.document.hidden = true
  app.finish('s1')
  assert.equal(app.document.title, '🔔 任务完成')
})

check('窗口可见时不改标题', () => {
  const app = boot()
  app.document.hidden = false
  app.finish('s1')
  assert.equal(app.document.title, 'DSH 会话')
})

check('子代理会话结束不改标题', () => {
  const app = boot({ rows: { s1: { origin: 'subagent', running: false } } })
  app.document.hidden = true
  app.finish('s1')
  assert.equal(app.document.title, 'DSH 会话')
})

check('加载时没在跑、又收到一次 false，不误报', () => {
  const app = boot({ rows: { s1: { running: false } } })
  app.document.hidden = true
  app.status('s1', false)
  assert.equal(app.document.title, 'DSH 会话')
})

check('加载时已在跑（基线为 true），结束仍会提醒', () => {
  const app = boot({ rows: { s1: { running: true } } })
  app.document.hidden = true
  app.finish('s1')
  assert.equal(app.document.title, '🔔 任务完成')
})

check('重复的结束事件只标记一次', () => {
  const app = boot()
  app.document.hidden = true
  app.finish('s1')
  app.finish('s1')
  assert.equal(app.document.title, '🔔 任务完成')
})

check('回到窗口后标题恢复', () => {
  const app = boot()
  app.document.hidden = true
  app.finish('s1')
  app.window.dispatch('focus')
  assert.equal(app.document.title, 'DSH 会话')
})

check('窗口点击也能恢复标题', () => {
  const app = boot()
  app.document.hidden = true
  app.finish('s1')
  app.window.dispatch('pointerdown')
  assert.equal(app.document.title, 'DSH 会话')
})

check('可见性变化也能恢复标题', () => {
  const app = boot()
  app.document.hidden = true
  app.finish('s1')
  app.document.dispatch('visibilitychange')
  assert.equal(app.document.title, 'DSH 会话')
})

check('卸载后监听全部摘除且标题还原', () => {
  const app = boot()
  app.document.hidden = true
  app.finish('s1')
  app.dispose()
  assert.equal(app.document.title, 'DSH 会话')
  assert.equal(app.remaining(), 0)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
