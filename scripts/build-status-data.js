import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServiceSummary, makeBadgeSvg } from '../src/status-data.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(resolve(root, 'status-page/config.json'), 'utf8'))
const maintenanceConfig = JSON.parse(await readFile(resolve(root, 'status-page/maintenance.json'), 'utf8'))
const token = process.env.GITHUB_TOKEN
if (!token) throw new Error('GITHUB_TOKEN is required to build public status data.')

const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }

async function api(path) {
  const response = await fetch(`${apiBase}${path}`, { headers })
  if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`)
  return response.json()
}

async function allPages(path) {
  const items = []
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const batch = await api(`${path}${separator}per_page=100&page=${page}`)
    items.push(...batch)
    if (batch.length < 100) break
  }
  return items
}

const repository = config.repository
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository in status-page/config.json')
const repoPath = `/repos/${repository}`
const issues = await allPages(`${repoPath}/issues?state=all&sort=updated&direction=desc`)
const metricsIssue = issues.find((issue) => !issue.pull_request && issue.title === config.metricsIssueTitle)
const now = Date.now()
const cutoff = now - 30 * 24 * 60 * 60 * 1000
const samplesByService = Object.fromEntries(config.services.map((service) => [service.id, []]))

if (metricsIssue) {
  const comments = await allPages(`${repoPath}/issues/${metricsIssue.number}/comments?sort=created&direction=desc`)
  for (const comment of comments) {
    const marker = comment.body?.match(/websocket-monitor-series:v1:([a-z0-9_-]+):(\d{4}-\d{2}-\d{2})/)
    if (!marker || !samplesByService[marker[1]]) continue
    const payload = comment.body.match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/)
    if (!payload) continue
    try {
      const parsed = JSON.parse(payload[1])
      if (parsed.version !== 1 || parsed.service !== marker[1] || !Array.isArray(parsed.samples)) continue
      for (const sample of parsed.samples) {
        if (Array.isArray(sample) && Number.isFinite(sample[0]) && sample[0] >= cutoff && sample[0] <= now
          && (sample[1] === 0 || sample[1] === 1)) samplesByService[marker[1]].push(sample)
      }
    } catch { /* Ignore malformed or manually edited history comments. */ }
  }
}

for (const id of Object.keys(samplesByService)) {
  const unique = new Map(samplesByService[id].map((sample) => [sample[0], sample]))
  samplesByService[id] = [...unique.values()].sort((a, b) => a[0] - b[0])
}

const maintenances = (maintenanceConfig.maintenances ?? []).filter((item) => item && item.startsAt && item.endsAt)
const services = config.services.map((service) => buildServiceSummary(
  service,
  samplesByService[service.id],
  now,
  maintenances.filter((item) => item.service === service.id || item.service === 'all'),
))
const priority = ['down', 'degraded', 'maintenance', 'unknown', 'operational']
const overallStatus = priority.find((status) => services.some((service) => service.status === status)) ?? 'unknown'
const badgeColor = { operational: '#238636', degraded: '#9a6700', down: '#cf222e', maintenance: '#0969da', unknown: '#6e7781' }
const badgeText = { operational: 'operational', degraded: 'degraded', down: 'down', maintenance: 'maintenance', unknown: 'no data' }
const badgeEntries = [
  { id: 'overall', label: 'status', status: overallStatus },
  ...services.map((service) => ({ id: service.id, label: service.id, status: service.status })),
]
const badges = []
await mkdir(resolve(root, 'status-page/data'), { recursive: true })
await mkdir(resolve(root, 'status-page/badges'), { recursive: true })

for (const badge of badgeEntries) {
  const path = `./badges/${badge.id}.svg`
  await writeFile(resolve(root, 'status-page', 'badges', `${badge.id}.svg`), makeBadgeSvg(badge.label, badgeText[badge.status], badgeColor[badge.status]))
  badges.push({ id: badge.id, label: badge.label, status: badge.status, path })
}

const status = {
  schemaVersion: 1,
  generatedAt: new Date(now).toISOString(),
  overallStatus,
  services,
  badges,
  samplePolicy: 'availability-is-based-on-executed-protocol-checks-only',
}
const history = {
  schemaVersion: 1,
  generatedAt: new Date(now).toISOString(),
  window: '30d',
  services: samplesByService,
}
const incidents = issues
  .filter((issue) => !issue.pull_request && issue.title?.startsWith('[WebSocket Monitor][DOWN]'))
  .map((issue) => {
    const serviceId = issue.title.match(/\[DOWN\]\[([^\]]+)\]/)?.[1] ?? null
    const startedAt = issue.created_at
    const closedAt = issue.closed_at
    const durationMs = closedAt ? Math.max(0, Date.parse(closedAt) - Date.parse(startedAt)) : Math.max(0, now - Date.parse(startedAt))
    const minutes = Math.floor(durationMs / 60_000)
    const duration = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}min` : `${minutes}min`
    return {
      number: issue.number,
      title: issue.title.replace(/^\[WebSocket Monitor\]\[DOWN\]\[[^\]]+\]\s*/, ''),
      service: serviceId,
      serviceName: config.services.find((service) => service.id === serviceId)?.name ?? serviceId,
      state: issue.state,
      startedAt,
      closedAt,
      duration,
      url: issue.html_url,
    }
  })
  .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))

const outputs = [
  ['status-page/data/status.json', status],
  ['status-page/data/history.json', history],
  ['status-page/data/incidents.json', { schemaVersion: 1, generatedAt: new Date(now).toISOString(), incidents }],
]
for (const [path, value] of outputs) {
  const target = resolve(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`)
}

console.log(`Built status data: ${services.length} services, ${Object.values(samplesByService).reduce((sum, items) => sum + items.length, 0)} real samples, ${incidents.length} incidents.`)
