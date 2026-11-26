import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isIntervalDue, parseBoolean, positiveInteger, runMonitor } from '../src/monitor.js'

function createLog() {
  const entries = { info: [], warn: [], error: [] }
  return {
    entries,
    log: Object.fromEntries(Object.keys(entries).map((level) => [level, (message) => entries[level].push(message)])),
  }
}

const urls = {
  MCRAFT_TRYSTERO_WS_URL: 'wss://trystero.example.test/',
  EAGLERCRAFT_RELAY_WS_URL: 'wss://eagler.example.test/',
  PEERJS_WS_URL: 'https://peerjs.example.test/peerjs',
  WISP_WS_URL: 'wss://wisp.example.test/wisp/',
}

test('parses boolean and positive interval settings with safe fallbacks', () => {
  assert.equal(parseBoolean('false', true), false)
  assert.equal(parseBoolean('ON', false), true)
  assert.equal(parseBoolean('invalid', true), true)
  assert.equal(positiveInteger('12', 5), 12)
  assert.equal(positiveInteger('0', 5), 5)
  assert.equal(positiveInteger('1.5', 5), 5)
})

test('calculates independent UTC schedule intervals', () => {
  const atMinuteTen = Date.UTC(2026, 10, 25, 12, 10) 
  assert.equal(isIntervalDue(5, atMinuteTen), true)
  assert.equal(isIntervalDue(10, atMinuteTen), true)
  assert.equal(isIntervalDue(7, atMinuteTen), false)
})

test('global switch skips all services', async () => {
  const { log, entries } = createLog()
  const code = await runMonitor({ ...urls, WS_MONITOR_ENABLED: 'false' }, {
    log,
    probe: async () => { throw new Error('must not run') },
  })
  assert.equal(code, 0)
  assert.match(entries.info[0], /desativou o monitor global/)
})

test('per-service switches and URL presence define safe defaults', async () => {
  const { log } = createLog()
  const calls = []
  const { WISP_WS_URL: _unusedWispUrl, ...withoutWispUrl } = urls
  const code = await runMonitor({
    ...withoutWispUrl,
    PEERJS_MONITOR_ENABLED: 'false',
    WISP_MONITOR_ENABLED: 'true',
  }, {
    log,
    force: true,
    maxAttempts: 1,
    probes: Object.fromEntries(['trystero', 'eaglercraft', 'peerjs', 'wisp'].map((id) => [id, async () => { calls.push(id); return { elapsedMs: 1 } }])),
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, ['trystero', 'eaglercraft'])
})

test('uses the global interval when a service interval is not set', async () => {
  const { log } = createLog()
  const calls = []
  const code = await runMonitor({
    ...urls,
    WS_MONITOR_INTERVAL_MINUTES: '10',
    TRYSTERO_MONITOR_INTERVAL_MINUTES: '15',
    PEERJS_MONITOR_ENABLED: 'false',
    WISP_MONITOR_ENABLED: 'false',
    GITHUB_EVENT_NAME: 'schedule',
  }, {
    log,
    now: Date.UTC(2026, 10, 25, 12, 10),
    probes: Object.fromEntries(['trystero', 'eaglercraft', 'peerjs', 'wisp'].map((id) => [id, async () => { calls.push(id); return { elapsedMs: 1 } }])),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['eaglercraft'])
})

test('manual dispatch forces all enabled services regardless of interval', async () => {
  const { log } = createLog()
  const calls = []
  const code = await runMonitor({
    ...urls,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    WS_MONITOR_INTERVAL_MINUTES: '90',
  }, {
    log,
    probes: Object.fromEntries(['trystero', 'eaglercraft', 'peerjs', 'wisp'].map((id) => [id, async () => { calls.push(id); return { elapsedMs: 1 } }])),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['trystero', 'eaglercraft', 'peerjs', 'wisp'])
})

test('one protocol failure does not prevent the other enabled services', async () => {
  const { log } = createLog()
  const calls = []
  const code = await runMonitor({ ...urls, PEERJS_MONITOR_ENABLED: 'false', WISP_MONITOR_ENABLED: 'false' }, {
    log,
    force: true,
    maxAttempts: 1,
    probes: {
      trystero: async () => { calls.push('trystero'); throw new Error('private endpoint should not be logged') },
      eaglercraft: async () => { calls.push('eaglercraft'); return { elapsedMs: 1 } },
    },
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, ['trystero', 'eaglercraft'])
})
