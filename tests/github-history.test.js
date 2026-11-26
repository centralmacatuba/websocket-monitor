import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishGitHubHistory, recordCheckHistory, syncIncidents } from '../src/github-history.js'

function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    const route = routes.find((item) => item.match(url, options))
    if (!route) throw new Error(`Unexpected request: ${url}`)
    return { ok: route.status < 400, status: route.status, json: async () => route.body }
  }
  return { fetchImpl, calls }
}

const env = { GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'owner/repo' }

test('opens one incident issue on DOWN and avoids duplicate notifications', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 7 } },
  ])
  await syncIncidents([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], env, { fetchImpl, now: Date.UTC(2026, 10, 25) })
  assert.equal(calls.length, 2)
  assert.match(calls[1].options.body, /\[WebSocket Monitor\]\[DOWN\]\[eaglercraft-wisp\]/)
})

test('closes an active incident after recovery', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [{ number: 9, title: '[WebSocket Monitor][DOWN][eaglercraft-wisp] Wisp' }] },
    { match: (url) => url.endsWith('/issues/9/comments'), status: 201, body: {} },
    { match: (url) => url.endsWith('/issues/9'), status: 200, body: {} },
  ])
  await syncIncidents([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 12 }], env, { fetchImpl })
  assert.equal(calls.length, 3)
  assert.match(calls[2].options.body, /"state":"closed"/)
})

test('records first real protocol check in a new daily service series', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 15 } },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [] },
    { match: (url) => url.endsWith('/issues/15/comments') && url.includes('/repos/owner/repo'), status: 201, body: { id: 100 } },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 18, attempts: 1 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12),
  })
  assert.equal(result.writes[0].action, 'created')
  assert.equal(calls.length, 4)
  assert.match(calls[3].options.body, /websocket-monitor-series:v1:eaglercraft-wisp:2026-11-25/)
  assert.match(calls[3].options.body, /\[1795608000000,1,18,1\]/)
})

test('appends a check to an existing series comment without duplicating timestamps', async () => {
  const marker = '<!-- websocket-monitor-series:v1:eaglercraft-wisp:2026-11-25 -->'
  const body = `${marker}\n\n\`\`\`json\n{"version":1,"service":"eaglercraft-wisp","date":"2026-11-25","samples":[[1795608000000,1,18,1]]}\n\`\`\``
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [{ number: 15, title: '[WebSocket Monitor][Metrics] Daily health history' }] },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [{ id: 100, body }] },
    { match: (url) => url.endsWith('/issues/comments/100'), status: 200, body: {} },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: false, elapsedMs: 500, attempts: 8 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12, 5),
  })
  assert.equal(result.writes[0].action, 'updated')
  assert.equal(calls.length, 3)
  assert.match(calls[2].options.body, /\[1795608300000,0,500,8\]/)
})

test('does not create a history record for disabled, not-due, or unconfigured services', async () => {
  const { fetchImpl, calls } = mockFetch([])
  const result = await recordCheckHistory([
    { service: 'eaglercraft-eaglercraft-wisp', status: 'not_due' },
    { service: 'mcraft-p2p-peerjs', status: 'disabled' },
    { service: 'eaglercraft-relay', status: 'misconfigured', ok: false },
  ], env, { fetchImpl })
  assert.deepEqual(result, { skipped: true, reason: 'no-checks' })
  assert.equal(calls.length, 0)
})

test('history publishing is skipped safely without a token or repository', async () => {
  assert.deepEqual(await publishGitHubHistory([], {}), { skipped: true })
})

test('does not open a false incident during a scheduled maintenance window', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
  ])
  await syncIncidents([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], env, {
    fetchImpl,
    now: Date.UTC(2026, 10, 25, 12),
    maintenances: [{ service: 'eaglercraft-eaglercraft-wisp', startsAt: '2026-11-25T11:00:00.000Z', endsAt: '2026-11-25T13:00:00.000Z' }],
  })
  assert.equal(calls.length, 1)
})

test('persists check samples even when incident notification creation fails', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST' && options.body.includes('[WebSocket Monitor][DOWN]'), status: 500, body: {} },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST' && options.body.includes('[WebSocket Monitor][Metrics]'), status: 201, body: { number: 18 } },
    { match: (url) => url.includes('/issues/18/comments?'), status: 200, body: [] },
    { match: (url) => url.endsWith('/issues/18/comments'), status: 201, body: { id: 101 } },
  ])
  await assert.rejects(
    publishGitHubHistory([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: false, elapsedMs: null, attempts: 8 }], env, {
      fetchImpl,
      now: Date.UTC(2026, 10, 25, 12),
    }),
    /synchronization was incomplete/,
  )
  assert.ok(calls.some((call) => call.url.endsWith('/issues/18/comments')))
})

test('does not suppress incidents for a maintenance window marked completed', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 19 } },
  ])
  await syncIncidents([{ service: 'eaglercraft-eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], env, {
    fetchImpl,
    now: Date.UTC(2026, 10, 25, 12),
    maintenances: [{ service: 'eaglercraft-eaglercraft-wisp', status: 'completed', startsAt: '2026-11-25T11:00:00.000Z', endsAt: '2026-11-25T13:00:00.000Z' }],
  })
  assert.equal(calls.length, 2)
})
