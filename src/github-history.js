const API_VERSION = '2022-11-28'
const METRICS_TITLE = '[WebSocket Monitor][Metrics] Daily health history'

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'Content-Type': 'application/json',
  }
}

async function githubRequest(path, token, options = {}, fetchImpl = fetch, apiUrl = 'https://api.github.com') {
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers ?? {}) },
  })
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
    '## Relay unavailable',
    '',
    `- **Service:** ${result.name}`,
    `- **Detected at (UTC):** ${new Date(now).toISOString()}`,
    `- **Failed attempts:** ${result.attempts ?? 'unknown'}`,
    '- **Check:** protocol-level health probe',
    '',
    'This incident is automatically closed when a subsequent scheduled check succeeds.',
    'No endpoint URL, credential, peer ID, or probe payload is included in this report.',
  ].join('\n')
}

/**
 * Use GitHub Issues as a durable incident log and notification channel.
 * One open issue represents one ongoing outage for each monitored service.
 */
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
      await githubRequest(`${repository}/issues`, token, {
        method: 'POST',
        body: JSON.stringify({ title, body: incidentBody(result, now) }),
      }, fetchImpl, apiUrl)
    } else if (result.ok === true && active) {
      await githubRequest(`${repository}/issues/${active.number}/comments`, token, {
        method: 'POST',
        body: JSON.stringify({
          body: `## Service recovered\n\n- **Recovered at (UTC):** ${new Date(now).toISOString()}\n- **Successful check:** protocol-level health probe\n\nThe incident is being closed automatically.`,
        }),
      }, fetchImpl, apiUrl)
      await githubRequest(`${repository}/issues/${active.number}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      }, fetchImpl, apiUrl)
    }
  }

  return { skipped: false }
}

/**
 * Keep one daily latency/status snapshot as an issue comment. The issue body
 * stores the last UTC date to make scheduled/manual reruns idempotent.
 */
export async function recordDailySnapshot(results, env = process.env, options = {}) {
  const token = env.GITHUB_TOKEN
  if (!token) return { skipped: true, reason: 'missing-token' }

  const repository = repoPath(env.GITHUB_REPOSITORY)
  const fetchImpl = options.fetchImpl ?? fetch
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com'
  const now = options.now ?? Date.now()
  const date = new Date(now).toISOString().slice(0, 10)
  const included = results.filter((result) => result.service && !['disabled', 'not_due', 'misconfigured'].includes(result.status))
  if (included.length === 0) return { skipped: true, reason: 'no-checks' }
  const rows = included.map((result) => `| ${result.name} | ${result.ok ? 'UP' : 'DOWN'} | ${Number.isFinite(result.elapsedMs) ? `${Math.round(result.elapsedMs)} ms` : '—'} | ${result.attempts ?? '—'} |`)
  const snapshot = [
    `## ${date} (UTC)`,
    '',
    '| Service | Status | Probe latency | Attempts |',
    '|---|---|---:|---:|',
    ...rows,
    '',
    '_Latency is the protocol probe duration, not only the WebSocket handshake time._',
  ].join('\n')
  const issues = await githubRequest(`${repository}/issues?state=open&per_page=100`, token, {}, fetchImpl, apiUrl)
  let metricsIssue = issues.find((issue) => !issue.pull_request && issue.title === METRICS_TITLE)

  if (!metricsIssue) {
    metricsIssue = await githubRequest(`${repository}/issues`, token, {
      method: 'POST',
      body: JSON.stringify({
        title: METRICS_TITLE,
        body: [
          '# Daily monitor snapshots',
          '',
          'This issue stores one status and latency snapshot per UTC day.',
          'Outage start and recovery timestamps are tracked in individual incident issues.',
          '',
          snapshot,
          '',
          `<!-- websocket-monitor-last-daily:${date} -->`,
        ].join('\n'),
      }),
    }, fetchImpl, apiUrl)
    // The initial issue is the snapshot record for today.
  } else {
    const previousDate = metricsIssue.body?.match(/<!-- websocket-monitor-last-daily:(\d{4}-\d{2}-\d{2}) -->/)?.[1]
    if (previousDate === date) return { skipped: true, reason: 'already-recorded' }

    await githubRequest(`${repository}/issues/${metricsIssue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body: snapshot }),
    }, fetchImpl, apiUrl)

    const body = (metricsIssue.body ?? '').replace(/<!-- websocket-monitor-last-daily:\d{4}-\d{2}-\d{2} -->/g, '').trimEnd()
    await githubRequest(`${repository}/issues/${metricsIssue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ body: `${body}\n\n<!-- websocket-monitor-last-daily:${date} -->` }),
    }, fetchImpl, apiUrl)
  }

  return { skipped: false, issueNumber: metricsIssue.number }
}

export async function publishGitHubHistory(results, env = process.env, options = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { skipped: true }
  const incidents = await syncIncidents(results, env, options)
  const daily = await recordDailySnapshot(results, env, options)
  return { incidents, daily }
}
