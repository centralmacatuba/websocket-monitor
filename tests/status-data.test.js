import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildServiceSummary, calculateUptime, classifyService, effectiveIntervalMinutes, makeBadgeSvg } from '../src/status-data.js'

const now = Date.UTC(2026, 10, 25, 12)
const config = { id: 'eaglercraft-wisp', name: 'Wisp', expectedIntervalMinutes: 5, degradedLatencyMs: 2000 }

test('calculates uptime from actual successful and failed checks', () => {
  const samples = [
    [now - 3000, 1, 100, 1],
    [now - 2000, 1, 120, 1],
    [now - 1000, 0, 500, 8],
  ]
  const result = calculateUptime(samples, now, 60_000)
  assert.equal(result.checks, 3)
  assert.equal(result.successfulChecks, 2)
  assert.equal(result.failedChecks, 1)
  assert.equal(result.uptime, 66.667)
})

test('does not invent uptime when there are no samples', () => {
  const result = calculateUptime([], now, 60_000)
  assert.equal(result.uptime, null)
  assert.equal(result.checks, 0)
})

test('excludes samples inside explicitly excluded maintenance windows', () => {
  const maintenance = [{ service: 'eaglercraft-wisp', startsAt: new Date(now - 2500).toISOString(), endsAt: new Date(now - 500).toISOString(), excludeFromUptime: true }]
  const samples = [[now - 3000, 1, 100, 1], [now - 2000, 0, 500, 8], [now - 1000, 0, 500, 8]]
  const result = calculateUptime(samples, now, 60_000, maintenance)
  assert.equal(result.checks, 1)
  assert.equal(result.uptime, 100)
})

test('classifies a recent failed probe as down', () => {
  assert.equal(classifyService([[now - 1000, 0, 500, 8]], config, now).status, 'down')
})

test('classifies high latency as degraded while protocol checks still succeed', () => {
  assert.equal(classifyService([[now - 1000, 1, 2500, 1]], config, now).status, 'degraded')
})

test('classifies stale samples as unknown instead of reporting false uptime', () => {
  assert.equal(classifyService([[now - 16 * 60_000, 1, 100, 1]], config, now).status, 'unknown')
})

test('global active maintenance applies to every service', () => {
  const maintenance = [{ service: 'all', title: 'Network maintenance', startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 1000).toISOString() }]
  assert.equal(classifyService([[now - 500, 0, 500, 8]], config, now, maintenance).status, 'maintenance')
})

test('summary exposes real uptime windows and latency percentiles', () => {
  const samples = Array.from({ length: 20 }, (_, index) => [now - index * 60_000, 1, 100 + index * 10, 1])
  const summary = buildServiceSummary(config, samples, now)
  assert.equal(summary.uptime['24h'].checks, 20)
  assert.equal(summary.uptime['7d'].uptime, 100)
  assert.equal(summary.latency24h.samples, 20)
  assert.equal(summary.latency24h.averageMs, 195)
  assert.equal(summary.status, 'operational')
  assert.equal(summary.staleAfterMs, 15 * 60_000)
})

test('generates a safe SVG badge with escaped text', () => {
  const svg = makeBadgeSvg('status', '<down>', '#cf222e')
  assert.match(svg, /&lt;down&gt;/)
  assert.match(svg, /<svg/)
})

test('uses the actual five-minute scheduler cadence for status freshness', () => {
  assert.equal(effectiveIntervalMinutes(5), 5)
  assert.equal(effectiveIntervalMinutes(10), 10)
  assert.equal(effectiveIntervalMinutes(11), 15)
  assert.equal(effectiveIntervalMinutes(60), 60)
  assert.equal(effectiveIntervalMinutes('invalid'), 5)
  assert.equal(effectiveIntervalMinutes('invalid', 15), 15)
})
