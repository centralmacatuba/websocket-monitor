export function effectiveIntervalMinutes(value, fallback = 5) {
  const parsed = Number(value)
  const fallbackValue = Number(fallback)
  const validFallback = Number.isSafeInteger(fallbackValue) && fallbackValue > 0 ? fallbackValue : 5
  const valid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : validFallback
  return Math.max(5, Math.ceil(valid / 5) * 5)
}

export const WINDOWS = Object.freeze({ '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 })

export function calculateUptime(samples, now = Date.now(), windowMs = WINDOWS['24h'], excludedRanges = []) {
  const start = now - windowMs
  const eligible = samples.filter((sample) => {
    if (!Array.isArray(sample) || !Number.isFinite(sample[0]) || sample[0] < start || sample[0] > now) return false
    return !excludedRanges.some((range) => range.excludeFromUptime !== false && sample[0] >= Date.parse(range.startsAt) && sample[0] <= Date.parse(range.endsAt))
  })
  const up = eligible.filter((sample) => sample[1] === 1).length
  const down = eligible.filter((sample) => sample[1] === 0).length
  const total = up + down
  return {
    uptime: total ? Number(((up / total) * 100).toFixed(3)) : null,
    checks: total,
    successfulChecks: up,
    failedChecks: down,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(now).toISOString(),
  }
}

export function classifyService(samples, config, now = Date.now(), maintenances = []) {
  const latest = [...samples].sort((a, b) => b[0] - a[0])[0]
  const activeMaintenance = maintenances.find((item) => (item.service === config.id || item.service === 'all') && item.status !== 'completed'
    && Date.parse(item.startsAt) <= now && Date.parse(item.endsAt) >= now)
  if (activeMaintenance) return { status: 'maintenance', maintenance: activeMaintenance, latestSample: latest ?? null }
  if (!latest) return { status: 'unknown', reason: 'no-data', latestSample: null }
  const staleAfter = Math.max(15, (config.expectedIntervalMinutes ?? 5) * 3) * 60_000
  if (now - latest[0] > staleAfter) return { status: 'unknown', reason: 'stale-data', latestSample: latest }
  if (latest[1] === 0) return { status: 'down', latestSample: latest }
  if (Number.isFinite(config.degradedLatencyMs) && latest[2] > config.degradedLatencyMs) {
    return { status: 'degraded', latestSample: latest }
  }
  return { status: 'operational', latestSample: latest }
}

export function buildServiceSummary(config, samples, now = Date.now(), maintenances = []) {
  const status = classifyService(samples, config, now, maintenances)
  const staleAfterMs = Math.max(15, (config.expectedIntervalMinutes ?? 5) * 3) * 60_000
  const metrics = Object.fromEntries(Object.entries(WINDOWS).map(([key, duration]) => [
    key,
    calculateUptime(samples, now, duration, maintenances.filter((item) => item.service === config.id || item.service === 'all')),
  ]))
  const recent = samples.filter((sample) => sample[0] >= now - WINDOWS['24h'] && sample[1] === 1 && Number.isFinite(sample[2]))
  const latencyValues = recent.map((sample) => sample[2]).sort((a, b) => a - b)
  const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null
  return {
    id: config.id,
    name: config.name,
    status: status.status,
    statusReason: status.reason ?? null,
    staleAfterMs,
    maintenance: status.maintenance ?? null,
    lastCheckedAt: status.latestSample ? new Date(status.latestSample[0]).toISOString() : null,
    latencyMs: status.latestSample?.[1] === 1 ? status.latestSample[2] : null,
    latency24h: {
      samples: latencyValues.length,
      averageMs: latencyValues.length ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length) : null,
      p95Ms: percentile(latencyValues, 0.95),
    },
    uptime: metrics,
  }
}

export function makeBadgeSvg(label, message, color) {
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  const left = escape(label)
  const right = escape(message)
  const leftWidth = Math.max(44, left.length * 7 + 12)
  const rightWidth = Math.max(48, right.length * 7 + 12)
  const width = leftWidth + rightWidth
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${left}: ${right}"><title>${left}: ${right}</title><linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${leftWidth}" height="20" fill="#555"/><rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${escape(color)}"/><rect width="${width}" height="20" fill="url(#g)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${leftWidth / 2}" y="14">${left}</text><text x="${leftWidth + rightWidth / 2}" y="14">${right}</text></g></svg>`
}
