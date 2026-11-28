import { createHmac } from 'node:crypto'

function enabled(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function notificationText(event) {
  const recovered = event.type === 'incident.recovered'
  const title = recovered ? 'Serviço recuperado' : 'Incidente confirmado'
  return [
    `[WebSocket Monitor] ${title}`,
    `Serviço: ${event.serviceName}`,
    `Estado: ${recovered ? 'operacional' : 'indisponível'}`,
    `Horário (UTC): ${event.timestamp}`,
    event.attempts ? `Tentativas: ${event.attempts}` : null,
    event.failureCode ? `Diagnóstico: ${event.failureCode}` : null,
    event.incidentUrl ? `Incidente: ${event.incidentUrl}` : null,
  ].filter(Boolean).join('\n')
}

function safeWebhookUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Custom notification webhook must use HTTPS')
  }
  if (url.username || url.password) throw new Error('Webhook URL credentials are not allowed')
  return url.toString()
}

/** Deliver an incident transition to the explicitly enabled external channels. */
export async function dispatchNotifications(event, env = process.env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Number.isSafeInteger(Number(env.WS_NOTIFY_TIMEOUT_MS)) && Number(env.WS_NOTIFY_TIMEOUT_MS) > 0
    ? Math.min(Number(env.WS_NOTIFY_TIMEOUT_MS), 15_000)
    : 8_000
  const payload = {
    schema: 'centralmacatuba.websocket-monitor.v1',
    event: event.type,
    occurredAt: event.timestamp,
    service: { id: event.service, name: event.serviceName },
    status: event.type === 'incident.recovered' ? 'operational' : 'down',
    attempts: event.attempts ?? null,
    failureCode: event.failureCode ?? null,
    incident: event.incidentUrl ? { url: event.incidentUrl } : null,
  }
  const text = notificationText(event)
  const tasks = []

  if (enabled(env.WS_NOTIFY_DISCORD_ENABLED)) {
    if (!env.WS_NOTIFY_DISCORD_WEBHOOK_URL) tasks.push(['discord', async () => { throw new Error('missing configuration') }])
    else tasks.push(['discord', async () => {
      const response = await fetchImpl(safeWebhookUrl(env.WS_NOTIFY_DISCORD_WEBHOOK_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error('Discord notification failed')
    }])
  }

  if (enabled(env.WS_NOTIFY_TELEGRAM_ENABLED)) {
    if (!env.WS_NOTIFY_TELEGRAM_BOT_TOKEN || !env.WS_NOTIFY_TELEGRAM_CHAT_ID) tasks.push(['telegram', async () => { throw new Error('missing configuration') }])
    else tasks.push(['telegram', async () => {
      const response = await fetchImpl(`https://api.telegram.org/bot${env.WS_NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.WS_NOTIFY_TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error('Telegram notification failed')
    }])
  }

  if (enabled(env.WS_NOTIFY_WEBHOOK_ENABLED)) {
    if (!env.WS_NOTIFY_WEBHOOK_URL) tasks.push(['webhook', async () => { throw new Error('missing configuration') }])
    else tasks.push(['webhook', async () => {
      const url = safeWebhookUrl(env.WS_NOTIFY_WEBHOOK_URL)
      const body = JSON.stringify(payload)
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'CentralMacatuba-WebSocket-Monitor/1.0' }
      if (env.WS_NOTIFY_WEBHOOK_SECRET) {
        headers['X-CM-Webhook-Signature'] = `sha256=${createHmac('sha256', env.WS_NOTIFY_WEBHOOK_SECRET).update(body).digest('hex')}`
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error('Custom webhook notification failed')
    }])
  }

  const settled = await Promise.all(tasks.map(async ([destination, promise]) => {
    try {
      await promise()
      return { destination, ok: true }
    } catch {
      return { destination, ok: false }
    }
  }))
  return { attempted: settled.length, results: settled }
}
