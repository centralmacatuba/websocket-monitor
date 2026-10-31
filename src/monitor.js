import { checkWebSocket, normalizeWebSocketUrl } from './check-websocket.js'

const TARGETS = [
  {
    name: 'Mcraft P2P (Trystero)',
    secret: 'MCRAFT_TRYSTERO_WS_URL',
  },
  {
    name: 'EaglerCraft Relay',
    secret: 'EAGLERCRAFT_RELAY_WS_URL',
  },
]

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeEndpoint(value) {
  const url = new URL(value)
  return `${url.protocol}//${url.host}${url.pathname}`
}

/**
 * Retry a target to tolerate Render Free cold starts. A successful check requires
 * both the WebSocket opening handshake and a Ping/Pong control-frame exchange.
 */
export async function monitorTarget({
  name,
  url,
}, {
  maxAttempts = 8,
  retryDelayMs = 10_000,
  connectTimeoutMs = 15_000,
  pongTimeoutMs = 5_000,
  closeTimeoutMs = 1_000,
  check = checkWebSocket,
  log = console,
} = {}) {
  const normalizedUrl = normalizeWebSocketUrl(url)
  const endpoint = safeEndpoint(normalizedUrl)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await check(normalizedUrl, {
        connectTimeoutMs,
        pongTimeoutMs,
        closeTimeoutMs,
      })

      log.info(`[UP] ${name}: WebSocket handshake + Ping/Pong OK (${result.elapsedMs} ms; tentativa ${attempt}/${maxAttempts}) — ${endpoint}`)
      return { ok: true, name, attempts: attempt, ...result }
    } catch (error) {
      log.warn(`[DOWN] ${name}: tentativa ${attempt}/${maxAttempts} — ${error.message}`)

      if (attempt < maxAttempts) {
        await sleep(retryDelayMs)
      }
    }
  }

  log.error(`[FAIL] ${name}: indisponível após ${maxAttempts} tentativas — ${endpoint}`)
  return { ok: false, name, attempts: maxAttempts }
}

export async function runMonitor(env = process.env, options = {}) {
  const targets = TARGETS.map(({ name, secret }) => ({
    name,
    url: env[secret],
    secret,
  }))

  const missing = targets.filter((target) => !target.url)
  if (missing.length) {
    for (const target of missing) {
      console.error(`[CONFIG] Secret ausente: ${target.secret}`)
    }
    return 1
  }

  const results = await Promise.all(
    targets.map(({ name, url }) => monitorTarget({ name, url }, options)),
  )

  const successful = results.filter((result) => result.ok).length
  console.info(`\nResultado: ${successful}/${results.length} relays WebSocket disponíveis.`)

  return successful === results.length ? 0 : 1
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const options = {
    maxAttempts: positiveInteger(process.env.WS_MAX_ATTEMPTS, 8),
    retryDelayMs: positiveInteger(process.env.WS_RETRY_DELAY_MS, 10_000),
    connectTimeoutMs: positiveInteger(process.env.WS_CONNECT_TIMEOUT_MS, 15_000),
    pongTimeoutMs: positiveInteger(process.env.WS_PONG_TIMEOUT_MS, 5_000),
    closeTimeoutMs: positiveInteger(process.env.WS_CLOSE_TIMEOUT_MS, 1_000),
  }

  runMonitor(process.env, options)
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      console.error('[FATAL] Falha inesperada no monitor:', error.message)
      process.exitCode = 1
    })
}
