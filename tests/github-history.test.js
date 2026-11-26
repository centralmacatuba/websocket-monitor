import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishGitHubHistory, recordDailySnapshot, syncIncidents } from '../src/github-history.js'

function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    const route = routes.find((item) => item.match(url, options))
    if (!route) throw new Error(`Unexpected request: ${url}`)
    return {
      ok: route.status < 400,
      status: route.status,
      json: async () => route.body,
    }
  }
  return { fetchImpl, calls }
}

const env = { GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'owner/repo' }

test('opens one incident issue on DOWN and avoids duplicate notifications', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [] },
    { match: (url, options) => url.endsWith('/issues') && options.method === 'POST', status: 201, body: { number: 7 } },
  ])
  await syncIncidents([{ service: 'wisp', name: 'Wisp', ok: false, attempts: 8 }], env, { fetchImpl, now: Date.UTC(2026, 10, 25) })
  assert.equal(calls.length, 2)
  assert.match(calls[1].options.body, /\[WebSocket Monitor\]\[DOWN\]\[wisp\]/)
})

test('closes an active incident after recovery', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [{ number: 9, title: '[WebSocket Monitor][DOWN][wisp] Wisp' }] },
    { match: (url) => url.endsWith('/issues/9/comments'), status: 201, body: {} },
    { match: (url) => url.endsWith('/issues/9'), status: 200, body: {} },
  ])
  await syncIncidents([{ service: 'wisp', name: 'Wisp', ok: true, elapsedMs: 12 }], env, { fetchImpl })
  assert.equal(calls.length, 3)
  assert.match(calls[2].options.body, /"state":"closed"/)
})

test('daily snapshots are idempotent for the same UTC date', async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: (url) => url.includes('/issues?state=open'), status: 200, body: [{ number: 12, title: '[WebSocket Monitor][Metrics] Daily health history', body: '<!-- websocket-monitor-last-daily:2026-11-25 -->' }] },
  ])
  const result = await recordDailySnapshot([{ service: 'wisp', name: 'Wisp', ok: true, elapsedMs: 12 }], env, {
    fetchImpl,
    now: Date.UTC(2026, 10, 25, 12),
  })
  assert.deepEqual(result, { skipped: true, reason: 'already-recorded' })
  assert.equal(calls.length, 1)
})

test('history publishing is skipped safely without a token or repository', async () => {
  assert.deepEqual(await publishGitHubHistory([], {}), { skipped: true })
})
