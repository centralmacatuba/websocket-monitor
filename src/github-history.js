const API_VERSION = '2022-11-28'
const METRICS_TITLE = '[WebSocket Monitor][Metrics] Daily health history'
const SERIES_MARKER = (service, date) => `<!-- websocket-monitor-series:v1:${service}:${date} -->`

function headers(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION, 'Content-Type': 'application/json' }
}

async function githubRequest(path, token, options = {}, fetchImpl = fetch, apiUrl = 'https://api.github.com') {
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, { ...options, headers: { ...headers(token), ...(options.headers ?? {}) } })
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`)
  if (response.status === 204) return null
  return response.json()
}

function repoPath(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is invalid')
  return `/repos/${repository}`
}

function incidentTitle(result) {
  return `[WebSocket Monitor][DOWN][${result.service}] ${result.name}`
}

function incidentBody(result, now) {
  return [
    '## Relay unavailable', '',
    `- **Service:** ${result.name}`,
    `- **Detected at (UTC):** ${new Date(now).toISOString()}`,
    `- **Failed attempts:** ${result.attempts ?? 'unknown'}`,
    '- **Check:** protocol-level health probe', '',
    'This incident is automatically closed when a subsequent scheduled check succeeds.',
    'No endpoint URL, credential, peer ID, or probe payload is included in this report.',
  ].join('\n')
}

export async function syncIncidents(results, env = process.env, options = {}) {
  const token = env.GITHUB_TOKEN
  if (!token) return { skipped: true, reason: 'missing-token' }
  const repository = repoPath(env.GITHUB_REPOSITORY)
  const fetchImpl = options.fetchImpl ?? fetch
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com'
  const now = options.now ?? Date.now()
  const openIssues = await githubRequest(`${repository}/issues?state=open&per_page=100`, token, {}, fetchImpl, apiUrl)
  const issues = openIssues.filter((issue) => !issue.pull_request)

  for (const result of results) {
    if (!result.service || result.status === 'disabled' || result.status === 'not_due' || result.status === 'misconfigured') continue
    const title = incidentTitle(result)
    const active = issues.find((issue) => issue.title === title)
    if (result.ok === false && !active) {
      await githubRequest(`${repository}/issues`, token, { method: 'POST', body: JSON.stringify({ title, body: incidentBody(result, now) }) }, fetchImpl, apiUrl)
    } else if (result.ok === true && active) {
      await githubRequest(`${repository}/issues/${active.number}/comments`, token, {
        method: 'POST',
        body: JSON.stringify({ body: `## Service recovered\n\n- **Recovered at (UTC):** ${new Date(now).toISOString()}\n- **Successful check:** protocol-level health probe\n\nThe incident is being closed automatically.` }),
      }, fetchImpl, apiUrl)
      await githubRequest(`${repository}/issues/${active.number}`, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) }, fetchImpl, apiUrl)
    }
  }
  return { skipped: false }
}

function parseSeriesComment(body) {
  const match = body?.match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed.samples) ? parsed : null
  } catch { return null }
}

function renderSeriesComment(service, date, samples) {
  return [
    SERIES_MARKER(service, date),
    `## ${service} · ${date} (UTC)`, '',
    'Cada item representa uma verificação de protocolo realmente executada: [timestamp_ms, sucesso(1/0), latência_ms, tentativas].', '',
    '```json',
    JSON.stringify({ version: 1, service, date, samples }),
    '```',
  ].join('\n')
}

/** Persist every executed protocol check as a compact per-service daily series. */
export async function recordCheckHistory(results, env = process.env, options = {}) {
  const token = env.GITHUB_TOKEN
  if (!token) return { skipped: true, reason: 'missing-token' }
  const repository = repoPath(env.GITHUB_REPOSITORY)
  const fetchImpl = options.fetchImpl ?? fetch
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com'
  const now = options.now ?? Date.now()
  const date = new Date(now).toISOString().slice(0, 10)
  const included = results.filter((result) => result.service && typeof result.ok === 'boolean')
  if (included.length === 0) return { skipped: true, reason: 'no-checks' }

  const issues = await githubRequest(`${repository}/issues?state=open&per_page=100`, token, {}, fetchImpl, apiUrl)
  let metricsIssue = issues.find((issue) => !issue.pull_request && issue.title === METRICS_TITLE)
  if (!metricsIssue) {
    metricsIssue = await githubRequest(`${repository}/issues`, token, {
      method: 'POST',
      body: JSON.stringify({ title: METRICS_TITLE, body: [
        '# WebSocket Monitor — raw check history', '',
        'Compact per-service daily JSON time series used by the public status page.',
        'Each sample is a real protocol probe. Availability is calculated from successful and failed executed checks; missing checks are not fabricated as uptime or downtime.',
        'Incident start/recovery timestamps are stored in the individual incident issues.',
      ].join('\n') }),
    }, fetchImpl, apiUrl)
  }

  const comments = await githubRequest(`${repository}/issues/${metricsIssue.number}/comments?per_page=100&sort=created&direction=desc`, token, {}, fetchImpl, apiUrl)
  const writes = []
  for (const result of included) {
    const marker = SERIES_MARKER(result.service, date)
    const existing = comments.find((comment) => comment.body?.includes(marker))
    const current = existing ? parseSeriesComment(existing.body) : null
    const samples = current?.samples ?? []
    if (!samples.some((item) => item[0] === now)) {
      samples.push([now, result.ok ? 1 : 0, Number.isFinite(result.elapsedMs) ? Math.max(0, Math.round(result.elapsedMs)) : null, Number.isFinite(result.attempts) ? result.attempts : null])
    }
    samples.sort((a, b) => a[0] - b[0])
    const body = renderSeriesComment(result.service, date, samples.slice(-500))
    if (existing) {
      await githubRequest(`/repos/${env.GITHUB_REPOSITORY}/issues/comments/${existing.id}`, token, { method: 'PATCH', body: JSON.stringify({ body }) }, fetchImpl, apiUrl)
      writes.push({ service: result.service, action: 'updated' })
    } else {
      const created = await githubRequest(`${repository}/issues/${metricsIssue.number}/comments`, token, { method: 'POST', body: JSON.stringify({ body }) }, fetchImpl, apiUrl)
      comments.unshift(created)
      writes.push({ service: result.service, action: 'created' })
    }
  }
  return { skipped: false, issueNumber: metricsIssue.number, writes }
}

export async function recordDailySnapshot(results, env = process.env, options = {}) {
  return recordCheckHistory(results, env, options)
}

export async function publishGitHubHistory(results, env = process.env, options = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { skipped: true }
  const incidents = await syncIncidents(results, env, options)
  const history = await recordCheckHistory(results, env, options)
  return { incidents, history }
}
