import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monitorTarget, runMonitor } from '../src/monitor.js'

function captureLog() {
  const entries = { info: [], warn: [], error: [] }
  return { entries, log: Object.fromEntries(Object.keys(entries).map((level) => [level, (message) => entries[level].push(message)])) }
}

const success = { ok: true, handshake: true, pong: true, elapsedMs: 7 }

test('passes normalized URL and timeout options to the checker and stops after success', async () => {
  const calls = []
  const { log, entries } = captureLog()
  const result = await monitorTarget({ name: 'relay', url: 'WS://EXAMPLE.test' }, {
    maxAttempts: 3, connectTimeoutMs: 12, pongTimeoutMs: 13, closeTimeoutMs: 14, log,
    check: async (...args) => { calls.push(args); return success },
  })
  assert.deepEqual(calls, [['ws://example.test/', { connectTimeoutMs: 12, pongTimeoutMs: 13, closeTimeoutMs: 14 }]])
  assert.deepEqual(result, { name: 'relay', attempts: 1, ...success })
  assert.match(entries.info[0], /\[UP\].*tentativa 1\/3/)
  assert.equal(entries.warn.length, 0)
})

test('retries failures up to the limit and reports a final failure', async () => {
  let calls = 0
  const { log, entries } = captureLog()
  const result = await monitorTarget({ name: 'relay', url: 'ws://example.test/' }, {
    maxAttempts: 3, retryDelayMs: 0, log,
    check: async () => { calls += 1; throw new Error('offline') },
  })
  assert.deepEqual(result, { ok: false, name: 'relay', attempts: 3 })
  assert.equal(calls, 3)
  assert.equal(entries.warn.length, 3)
  assert.match(entries.warn[2], /tentativa 3\/3 — offline/)
  assert.match(entries.error[0], /indisponível após 3 tentativas/)
})

test('rejects invalid configuration without invoking the checker', async () => {
  let called = false
  await assert.rejects(monitorTarget({ name: 'relay', url: 'https://example.test/' }, {
    check: async () => { called = true },
  }), /must use ws/)
  assert.equal(called, false)
})

test('missing secrets fail before either relay is checked', async (t) => {
  const error = t.mock.method(console, 'error', () => {})
  let calls = 0
  const code = await runMonitor({ MCRAFT_TRYSTERO_WS_URL: 'ws://example.test/' }, {
    check: async () => { calls += 1; return success },
  })
  assert.equal(code, 1)
  assert.equal(calls, 0)
  assert.match(error.mock.calls[0].arguments[0], /Secret ausente para: EaglerCraft Relay/)
})

test('checks both relays concurrently and summarizes success', async (t) => {
  const info = t.mock.method(console, 'info', () => {})
  const pending = []
  const promise = runMonitor({
    MCRAFT_TRYSTERO_WS_URL: 'ws://first.test/',
    EAGLERCRAFT_RELAY_WS_URL: 'wss://second.test/',
  }, { log: captureLog().log, check: (url) => new Promise((resolve) => pending.push({ url, resolve })) })
  assert.deepEqual(pending.map(({ url }) => url), ['ws://first.test/', 'wss://second.test/'])
  for (const item of pending) item.resolve(success)
  assert.equal(await promise, 0)
  assert.match(info.mock.calls[0].arguments[0], /2\/2 relays/)
})

test('a bad URL does not prevent the other relay from being checked', async (t) => {
  const error = t.mock.method(console, 'error', () => {})
  const info = t.mock.method(console, 'info', () => {})
  const calls = []
  const code = await runMonitor({
    MCRAFT_TRYSTERO_WS_URL: 'ws://user:secret@first.test/',
    EAGLERCRAFT_RELAY_WS_URL: 'ws://second.test/',
  }, { log: captureLog().log, check: async (url) => { calls.push(url); return success } })
  assert.equal(code, 1)
  assert.deepEqual(calls, ['ws://second.test/'])
  assert.match(error.mock.calls[0].arguments[0], /\[CONFIG\] Mcraft/)
  assert.doesNotMatch(error.mock.calls[0].arguments[0], /secret/)
  assert.match(info.mock.calls[0].arguments[0], /1\/2 relays/)
})

test('returns failure when a relay exhausts its attempts', async (t) => {
  t.mock.method(console, 'info', () => {})
  const code = await runMonitor({
    MCRAFT_TRYSTERO_WS_URL: 'ws://first.test/',
    EAGLERCRAFT_RELAY_WS_URL: 'ws://second.test/',
  }, {
    maxAttempts: 1, log: captureLog().log,
    check: async (url) => { if (url.includes('first')) throw new Error('offline'); return success },
  })
  assert.equal(code, 1)
})
