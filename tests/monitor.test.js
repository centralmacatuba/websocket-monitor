import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyProbeError, isIntervalDue, parseBoolean, positiveInteger, runMonitor } from '../src/monitor.js'

function createLog() {
  const entries = { info: [], warn: [], error: [] }
  return {
    entries,
    log: Object.fromEntries(Object.keys(entries).map((level) => [level, (message) => entries[level].push(message)])),
  }
}

const urls = {
  MCRAFT_P2P_WS_URL: 'wss://trystero.example.test/',
  EAGLERCRAFT_RELAY_WS_URL: 'wss://eagler.example.test/',
  MCRAFT_P2P_PEERJS_WS_URL: 'https://peerjs.example.test/peerjs',
  EAGLERCRAFT_WISP_WS_URL: 'wss://wisp.example.test/wisp/',
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
  assert.equal(isIntervalDue(7, atMinuteTen), true)
  assert.equal(isIntervalDue(5, Date.UTC(2026, 10, 25, 12, 11)), true)
  assert.equal(isIntervalDue(10, Date.UTC(2026, 10, 25, 12, 14)), true)
  assert.equal(isIntervalDue(10, Date.UTC(2026, 10, 25, 12, 15)), false)
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
  const { EAGLERCRAFT_WISP_WS_URL: _unusedWispUrl, ...withoutWispUrl } = urls
  const code = await runMonitor({
    ...withoutWispUrl,
    MCRAFT_P2P_PEERJS_MONITOR_ENABLED: 'false',
    EAGLERCRAFT_WISP_MONITOR_ENABLED: 'true',
  }, {
    log,
    force: true,
    maxAttempts: 1,
    probes: Object.fromEntries(['mcraft-p2p', 'eaglercraft-relay', 'mcraft-p2p-peerjs', 'eaglercraft-wisp'].map((id) => [id, async () => { calls.push(id); return { elapsedMs: 1 } }])),
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, ['mcraft-p2p', 'eaglercraft-relay'])
})

test('uses the global interval when a service interval is not set', async () => {
  const { log } = createLog()
  const calls = []
  const code = await runMonitor({
    ...urls,
    WS_MONITOR_INTERVAL_MINUTES: '10',
    MCRAFT_P2P_MONITOR_INTERVAL_MINUTES: '15',
    MCRAFT_P2P_PEERJS_MONITOR_ENABLED: 'false',
    EAGLERCRAFT_WISP_MONITOR_ENABLED: 'false',
    GITHUB_EVENT_NAME: 'schedule',
  }, {
    log,
    now: Date.UTC(2026, 10, 25, 12, 11),
    probes: Object.fromEntries(['mcraft-p2p', 'eaglercraft-relay', 'mcraft-p2p-peerjs', 'eaglercraft-wisp'].map((id) => [id, async () => { calls.push(id); return { elapsedMs: 1 } }])),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['eaglercraft-relay'])
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
    probes: Object.fromEntries(['mcraft-p2p', 'eaglercraft-relay', 'mcraft-p2p-peerjs', 'eaglercraft-wisp'].map((id) => [id, async () => { calls.push(id); return { elapsedMs: 1 } }])),
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['mcraft-p2p', 'eaglercraft-relay', 'mcraft-p2p-peerjs', 'eaglercraft-wisp'])
})

test('runs enabled service probes concurrently', async () => {
  const { log } = createLog()
  const started = []
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  const probes = Object.fromEntries(['mcraft-p2p', 'eaglercraft-relay', 'mcraft-p2p-peerjs', 'eaglercraft-wisp'].map((id) => [id, async () => {
    started.push(id)
    if (started.length === 4) release()
    await gate
    return { elapsedMs: 1 }
  }]))
  const result = await runMonitor(urls, { log, force: true, probes })
  assert.equal(result, 0)
  assert.deepEqual(started, ['mcraft-p2p', 'eaglercraft-relay', 'mcraft-p2p-peerjs', 'eaglercraft-wisp'])
})

test('one protocol failure does not prevent the other enabled services', async () => {
  const { log } = createLog()
  const calls = []
  const code = await runMonitor({ ...urls, MCRAFT_P2P_PEERJS_MONITOR_ENABLED: 'false', EAGLERCRAFT_WISP_MONITOR_ENABLED: 'false' }, {
    log,
    force: true,
    maxAttempts: 1,
    probes: {
      'mcraft-p2p': async () => { calls.push('mcraft-p2p'); throw new Error('private endpoint should not be logged') },
      'eaglercraft-relay': async () => { calls.push('eaglercraft-relay'); return { elapsedMs: 1 } },
    },
  })
  assert.equal(code, 1)
  assert.deepEqual(calls, ['mcraft-p2p', 'eaglercraft-relay'])
})

test('publishes incident history after protocol checks when GitHub credentials are available', async () => {
  const { log } = createLog()
  let published
  const code = await runMonitor({
    ...urls,
    MCRAFT_P2P_PEERJS_MONITOR_ENABLED: 'false',
    EAGLERCRAFT_RELAY_MONITOR_ENABLED: 'false',
    MCRAFT_P2P_MONITOR_ENABLED: 'false',
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
  }, {
    log,
    force: true,
    probes: { 'eaglercraft-wisp': async () => ({ elapsedMs: 23 }) },
    publishHistory: async (results, env, options) => {
      published = { results, env, options }
      return { notifications: [] }
    },
  })
  assert.equal(code, 0)
  assert.equal(published.results.filter((result) => result.ok).length, 1)
  assert.equal(log.entries.error.some((message) => message.includes('Não foi possível atualizar o histórico')), false)
  assert.equal(published.results.find((result) => result.service === 'eaglercraft-wisp').elapsedMs, 23)
  assert.equal(published.env.GITHUB_REPOSITORY, 'owner/repo')
})


test('classifies protocol failures without exposing raw exception messages', () => {
  assert.equal(classifyProbeError(new Error('Wisp v2 negotiation timed out')), 'negotiation_timeout')
  assert.equal(classifyProbeError(new Error('Wisp server did not negotiate protocol version 2')), 'protocol_version_mismatch')
  assert.equal(classifyProbeError(new Error('malformed Wisp frame')), 'message_parse_error')
  assert.equal(classifyProbeError(new Error('Wisp connection closed before negotiation completed')), 'connection_closed')
  assert.equal(classifyProbeError(new Error('WebSocket connection refused')), 'connection_refused')
  assert.equal(classifyProbeError(new Error('getaddrinfo ENOTFOUND relay.example.test')), 'dns_resolution_failed')
  assert.equal(classifyProbeError(new Error('unclassified failure')), 'probe_failed')
})

test('persists a stable failure category for a failed protocol probe', async () => {
  const { log } = createLog()
  let published
  const code = await runMonitor({
    ...urls,
    MCRAFT_P2P_MONITOR_ENABLED: 'false',
    EAGLERCRAFT_RELAY_MONITOR_ENABLED: 'false',
    MCRAFT_P2P_PEERJS_MONITOR_ENABLED: 'false',
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
  }, {
    log,
    force: true,
    maxAttempts: 1,
    probes: {
      'eaglercraft-wisp': async () => { throw new Error('Wisp v2 negotiation timed out') },
    },
    publishHistory: async (results) => { published = results; return { notifications: [] } },
  })
  assert.equal(code, 1)
  assert.equal(published.find((item) => item.service === 'eaglercraft-wisp').failureCode, 'negotiation_timeout')
})
