import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishGitHubHistory, recordCheckHistory, syncIncidents } from '../src/github-history.js'
import { METRICS_ISSUE_TITLE, findMetricsIssue } from '../src/metrics.js'

function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    const route = routes.find((item) => item.match(url, options))
    if (!route) throw new Error(`Unexpected request: ${url}`)
    return {
      ok: route.status < 400,
      status: route.status,
      json: async () => Array.isArray(route.body) && url.includes('/comments')
        ? route.body.map((comment) => ({ user: { login: 'github-actions[bot]' }, ...comment }))
        : route.body,
    }
  }
  return { fetchImpl, calls }
}

const env = { GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'owner/repo', WS_INCIDENT_CONFIRMATION_FAILURES: '1' }
const defaultEnv = { GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'owner/repo' }

test('opens one incident issue on DOWN and avoids duplicate notifications', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 7 } },
  ])
  await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], env, { fetchImpl, now: Date.UTC(2026, 10, 25) })
  assert.equal(calls.length, 2)
  assert.match(calls[1].options.body, /\[WebSocket Monitor\]\[DOWN\]\[eaglercraft-wisp\]/)
})

test('requires two consecutive failed samples before opening an incident by default', async () => {
  const now = Date.UTC(2026, 10, 27, 12)
  const marker = '<!-- websocket-monitor-series:v1:eaglercraft-wisp:2026-11-27 -->'
  const body = [marker, '', '```json', JSON.stringify({
    version: 1, service: 'eaglercraft-wisp', date: '2026-11-27',
    samples: [[now - 300000, 0, null, 8, 'connection_timeout'], [now, 0, null, 8, 'connection_timeout']],
  }), '```'].join('\n')
  const metricsIssue = { number: 15, title: METRICS_ISSUE_TITLE, state: 'open', user: { login: 'github-actions[bot]' } }
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [metricsIssue] },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [{ id: 101, body }] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 99, html_url: 'https://github.com/owner/repo/issues/99' } },
  ])
  const result = await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8, failureCode: 'connection_timeout' }], defaultEnv, { fetchImpl, now })
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].type, 'incident.opened')
  assert.equal(calls.length, 4)
})

test('does not open an incident for only one failed sample by default', async () => {
  const now = Date.UTC(2026, 10, 27, 12)
  const marker = '<!-- websocket-monitor-series:v1:eaglercraft-wisp:2026-11-27 -->'
  const body = [marker, '', '```json', JSON.stringify({
    version: 1, service: 'eaglercraft-wisp', date: '2026-11-27',
    samples: [[now, 0, null, 8, 'connection_timeout']],
  }), '```'].join('\n')
  const metricsIssue = { number: 15, title: METRICS_ISSUE_TITLE, state: 'open', user: { login: 'github-actions[bot]' } }
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [metricsIssue] },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [{ id: 101, body }] },
  ])
  const result = await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], { GITHUB_TOKEN: env.GITHUB_TOKEN, GITHUB_REPOSITORY: env.GITHUB_REPOSITORY }, { fetchImpl, now })
  assert.deepEqual(result.events, [])
  assert.equal(calls.length, 3)
})

test('closes an active incident after recovery', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [{ number: 9, title: '[WebSocket Monitor][DOWN][eaglercraft-wisp] Wisp', user: { login: 'github-actions[bot]' } }] },
    { match: (url) => url.endsWith('/issues/9/comments'), status: 201, body: {} },
    { match: (url) => url.endsWith('/issues/9'), status: 200, body: {} },
  ])
  await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 12 }], env, { fetchImpl })
  assert.equal(calls.length, 3)
  assert.match(calls[2].options.body, /"state":"closed"/)
})

test('records first real protocol check in a new daily service series', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 15 } },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [] },
    { match: (url) => url.endsWith('/issues/15/comments') && url.includes('/repos/owner/repo'), status: 201, body: { id: 100 } },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 18, attempts: 1 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12),
  })
  assert.equal(result.writes[0].action, 'created')
  assert.equal(calls.length, 4)
  assert.equal(JSON.parse(calls[1].options.body).title, METRICS_ISSUE_TITLE)
  assert.match(calls[3].options.body, /websocket-monitor-series:v1:eaglercraft-wisp:2026-11-25/)
  assert.match(calls[3].options.body, /\[1795608000000,1,18,1,null\]/)
})

test('appends a check to an existing series comment without duplicating timestamps', async () => {
  const marker = '<!-- websocket-monitor-series:v1:eaglercraft-wisp:2026-11-25 -->'
  const body = [marker, '', '```json', JSON.stringify({ version: 1, service: 'eaglercraft-wisp', date: '2026-11-25', samples: [[1795608000000, 1, 18, 1]] }), '```'].join('\n')
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [{ number: 15, title: '[WebSocket Monitor][Metrics] Daily health history', state: 'open', user: { login: 'github-actions[bot]' } }] },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [{ id: 100, body }] },
    { match: (url) => url.endsWith('/issues/comments/100'), status: 200, body: {} },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, elapsedMs: 500, attempts: 8 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12, 5),
  })
  assert.equal(result.writes[0].action, 'updated')
  assert.equal(calls.length, 3)
  assert.match(calls[2].options.body, /\[1795608300000,0,500,8,null\]/)
})

test('does not create a history record for disabled, not-due, or unconfigured services', async () => {
  const { fetchImpl, calls } = mockFetch([])
  const result = await recordCheckHistory([
    { service: 'eaglercraft-wisp', status: 'not_due' },
    { service: 'mcraft-p2p-peerjs', status: 'disabled' },
    { service: 'eaglercraft-relay', status: 'misconfigured', ok: false },
  ], env, { fetchImpl })
  assert.deepEqual(result, { skipped: true, reason: 'no-checks' })
  assert.equal(calls.length, 0)
})

test('history publishing is skipped safely without a token or repository', async () => {
  assert.deepEqual(await publishGitHubHistory([], {}), { skipped: true })
})

test('keeps completed incident events when a later service API call fails', async () => {
  const { fetchImpl } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST' && options.body.includes('eaglercraft-wisp'), status: 201, body: { number: 77, html_url: 'https://github.com/owner/repo/issues/77' } },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST' && options.body.includes('eaglercraft-relay'), status: 500, body: {} },
  ])
  const result = await syncIncidents([
    { service: 'eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 },
    { service: 'eaglercraft-relay', name: 'Relay', ok: false, attempts: 3 },
  ], env, { fetchImpl })
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].service, 'eaglercraft-wisp')
  assert.deepEqual(result.errors, [{ service: 'eaglercraft-relay', reason: 'github-api-failure' }])
})

test('does not open a false incident during a scheduled maintenance window', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
  ])
  await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], env, {
    fetchImpl,
    now: Date.UTC(2026, 10, 25, 12),
    maintenances: [{ service: 'eaglercraft-wisp', startsAt: '2026-11-25T11:00:00.000Z', endsAt: '2026-11-25T13:00:00.000Z' }],
  })
  assert.equal(calls.length, 1)
})

test('persists check samples even when incident notification creation fails', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST' && options.body.includes('[WebSocket Monitor][DOWN]'), status: 500, body: {} },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST' && options.body.includes('[WebSocket Monitor][Metrics]'), status: 201, body: { number: 18 } },
    { match: (url) => url.includes('/issues/18/comments?'), status: 200, body: [] },
    { match: (url) => url.endsWith('/issues/18/comments'), status: 201, body: { id: 101 } },
  ])
  await assert.rejects(
    publishGitHubHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, elapsedMs: null, attempts: 8 }], env, {
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
  await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: false, attempts: 8 }], env, {
    fetchImpl,
    now: Date.UTC(2026, 10, 25, 12),
    maintenances: [{ service: 'eaglercraft-wisp', status: 'completed', startsAt: '2026-11-25T11:00:00.000Z', endsAt: '2026-11-25T13:00:00.000Z' }],
  })
  assert.equal(calls.length, 2)
})


test('ignores history comments authored by users other than the trusted monitor identity', async () => {
  const marker = '<!-- websocket-monitor-series:v1:eaglercraft-wisp:2026-11-25 -->'
  const body = [marker, '', '```json', JSON.stringify({ version: 1, service: 'eaglercraft-wisp', date: '2026-11-25', samples: [[1795608000000, 1, 18, 1]] }), '```'].join('\n')
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [{ number: 15, title: METRICS_ISSUE_TITLE, state: 'open', user: { login: 'github-actions[bot]' } }] },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [{ id: 100, body, user: { login: 'untrusted-user' } }] },
    { match: (url, options) => url.endsWith('/issues/15/comments') && options.method === 'POST', status: 201, body: { id: 101 } },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 18, attempts: 1 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12),
  })
  assert.equal(result.writes[0].action, 'created')
  assert.equal(calls.length, 3)
})

test('reopens a closed metrics issue instead of creating a duplicate', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc'), status: 200, body: [{ number: 15, title: METRICS_ISSUE_TITLE, state: 'closed', user: { login: 'github-actions[bot]' } }] },
    { match: (url) => url.endsWith('/issues/15') && url.includes('/repos/owner/repo'), status: 200, body: {} },
    { match: (url) => url.includes('/issues/15/comments?'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues/15/comments') && options.method === 'POST', status: 201, body: { id: 101 } },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 18, attempts: 1 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12),
  })
  assert.equal(result.issueNumber, 15)
  assert.equal(calls.length, 4)
  assert.match(calls[1].options.body, /"state":"open"/)
})

test('history pagination continues beyond the former twenty-page cap', async () => {
  const pages = Array.from({ length: 21 }, (_, index) => ({
    match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc') && new URL(url).searchParams.get('page') === String(index + 1),
    status: 200,
    body: index < 20 ? Array.from({ length: 100 }, (_, item) => ({ number: index * 100 + item + 1, title: `unrelated ${index}-${item}` })) : [],
  }))
  pages.push(
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 2001 } },
    { match: (url) => url.includes('/issues/2001/comments?'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues/2001/comments') && options.method === 'POST', status: 201, body: { id: 9999 } },
  )
  const { fetchImpl, calls } = mockFetch(pages)
  const result = await recordCheckHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 18, attempts: 1 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12),
  })
  assert.equal(result.writes[0].action, 'created')
  assert.equal(calls.length, 24)
})

test('writer and status-page lookup share the same canonical metrics issue title', () => {
  const issue = { number: 44, title: METRICS_ISSUE_TITLE, user: { login: 'github-actions[bot]' } }
  assert.equal(findMetricsIssue([{ pull_request: {}, ...issue }, issue]), issue)
  assert.equal(findMetricsIssue([{ ...issue, user: { login: 'untrusted-user' } }, issue]), issue)
  assert.equal(findMetricsIssue([{ ...issue, user: { login: 'untrusted-user' } }]), null)
  assert.equal(findMetricsIssue([{ title: '[WebSocket Monitor][Metrics] Histórico diário de saúde' }]), null)
})

test('incident synchronization paginates before deciding an issue is absent', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `unrelated ${index}` }))
  const active = { number: 501, title: '[WebSocket Monitor][DOWN][eaglercraft-wisp] Wisp', user: { login: 'github-actions[bot]' } }
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open') && /[?&]page=1$/.test(url), status: 200, body: firstPage },
    { match: (url) => url.includes('/issues?state=open') && /[?&]page=2$/.test(url), status: 200, body: [active] },
    { match: (url) => url.endsWith('/issues/501/comments'), status: 201, body: {} },
    { match: (url) => url.endsWith('/issues/501'), status: 200, body: {} },
  ])
  await syncIncidents([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true }], env, { fetchImpl })
  assert.equal(calls.length, 4)
  assert.ok(calls[1].url.includes('page=2'))
  assert.match(calls[2].url, /issues\/501\/comments$/)
})

test('metrics history lookup paginates issues and comments before creating a series', async () => {
  const issuePage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `unrelated ${index}` }))
  const metricsIssue = { number: 700, title: METRICS_ISSUE_TITLE, state: 'open', user: { login: 'github-actions[bot]' } }
  const marker = '<!-- websocket-monitor-series:v1:eaglercraft-wisp:2026-11-25 -->'
  const body = [marker, '', '```json', JSON.stringify({ version: 1, service: 'eaglercraft-wisp', date: '2026-11-25', samples: [[1795608000000, 1, 18, 1]] }), '```'].join('\n')
  const commentPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `unrelated ${index}` }))
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc') && /[?&]page=1$/.test(url), status: 200, body: issuePage },
    { match: (url) => url.includes('/issues?state=all&sort=updated&direction=desc') && /[?&]page=2$/.test(url), status: 200, body: [metricsIssue] },
    { match: (url) => url.includes('/issues/700/comments?') && /[?&]page=1$/.test(url), status: 200, body: commentPage },
    { match: (url) => url.includes('/issues/700/comments?') && /[?&]page=2$/.test(url), status: 200, body: [{ id: 900, body }] },
    { match: (url) => url.endsWith('/issues/comments/900'), status: 200, body: {} },
  ])
  const result = await recordCheckHistory([{ service: 'eaglercraft-wisp', name: 'Wisp', ok: true, elapsedMs: 18, attempts: 1 }], env, {
    fetchImpl, now: Date.UTC(2026, 10, 25, 12, 5),
  })
  assert.equal(result.writes[0].action, 'updated')
  assert.equal(calls.length, 5)
  assert.ok(calls[3].url.includes('page=2'))
})
