import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWebSocket, normalizeWebSocketUrl } from './check-websocket.js'
import { checkTrystero } from './probes/trystero.js'
import { checkEaglerRelay } from './probes/eaglercraft-relay.js'
import { checkPeerJs } from './probes/peerjs.js'
import { checkWisp } from './probes/wisp.js'
import { publishGitHubHistory } from './github-history.js'

const SERVICES = [
  { id: 'mcraft-p2p', name: 'Mcraft P2P (Trystero)', urlKey: 'MCRAFT_P2P_WS_URL', enabledKey: 'MCRAFT_P2P_MONITOR_ENABLED', intervalKey: 'MCRAFT_P2P_MONITOR_INTERVAL_MINUTES', probe: checkTrystero },
  { id: 'eaglercraft-relay', name: 'EaglerCraft Relay', urlKey: 'EAGLERCRAFT_RELAY_WS_URL', enabledKey: 'EAGLERCRAFT_RELAY_MONITOR_ENABLED', intervalKey: 'EAGLERCRAFT_RELAY_MONITOR_INTERVAL_MINUTES', maxAttempts: 3, retryDelayMs: 20_000, probe: checkEaglerRelay },
  { id: 'mcraft-p2p-peerjs', name: 'Mcraft P2P (PeerJS legado)', urlKey: 'MCRAFT_P2P_PEERJS_WS_URL', enabledKey: 'MCRAFT_P2P_PEERJS_MONITOR_ENABLED', intervalKey: 'MCRAFT_P2P_PEERJS_MONITOR_INTERVAL_MINUTES', probe: checkPeerJs },
  { id: 'eaglercraft-wisp', name: 'EaglerCraft Wisp v2', urlKey: 'EAGLERCRAFT_WISP_WS_URL', enabledKey: 'EAGLERCRAFT_WISP_MONITOR_ENABLED', intervalKey: 'EAGLERCRAFT_WISP_MONITOR_INTERVAL_MINUTES', probe: checkWisp },
]

export function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function parseBoolean(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function isIntervalDue(intervalMinutes, now = Date.now()) {
  // GitHub scheduled workflows have a five-minute minimum cadence.
  const effectiveInterval = Math.max(5, Math.ceil(intervalMinutes / 5) * 5)
  const minute = Math.floor(now / 60_000)
  // A scheduled run may start a few minutes after its cron boundary.
  // The five-minute scheduler tick owns the first five minutes of each interval.
  return minute % effectiveInterval < 5
}

export function classifyProbeError(error) {
  const code = String(error?.code ?? '').toLowerCase()
  const message = String(error?.message ?? '').toLowerCase()
  if (code.includes('timeout') || /negotiation timed out|protocol timed out/.test(message)) return 'negotiation_timeout'
  if (/econnrefused|connection refused/.test(`${code} ${message}`)) return 'connection_refused'
  if (/enotfound|eai_again|dns|name resolution/.test(`${code} ${message}`)) return 'dns_resolution_failed'
  if (/timed out|timeout|etimedout|ehostunreach/.test(`${code} ${message}`)) return 'connection_timeout'
  if (/version 2|protocol version|downgrade/.test(message)) return 'protocol_version_mismatch'
  if (/malformed|truncated|parse|invalid frame|payload mismatch/.test(message)) return 'message_parse_error'
  if (/closed before|connection closed|socket closed/.test(message)) return 'connection_closed'
  if (/websocket|socket|handshake|connect|network/.test(message)) return 'websocket_error'
  return 'probe_failed'
}

function safeLog(log, level, message) {
  log[level]?.(message)
}

async function runService(service, url, options) {
  const {
    maxAttempts = service.maxAttempts ?? 8,
    retryDelayMs = service.retryDelayMs ?? 10_000,
    timeoutMs = 15_000,
    log = console,
    probe = service.probe,
  } = options
  const effectiveMaxAttempts = service.maxAttempts ?? maxAttempts
  const effectiveRetryDelayMs = service.retryDelayMs ?? retryDelayMs

  let lastFailureCode = 'probe_failed'\n  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now()
    try {
      const result = await probe(url, { timeoutMs })
      const elapsedMs = Number.isFinite(result.elapsedMs) ? result.elapsedMs : Date.now() - attemptStartedAt
      safeLog(log, 'info', `[UP] ${service.name}: transporte + protocolo OK (${elapsedMs} ms; tentativa ${attempt}/${effectiveMaxAttempts})`)
      return { ok: true, service: service.id, name: service.name, attempts: attempt, ...result, elapsedMs }
    } catch (error) {
      lastFailureCode = classifyProbeError(error)
      safeLog(log, 'warn', `[DOWN] ${service.name}: ${lastFailureCode} (tentativa ${attempt}/${effectiveMaxAttempts})`)
      if (attempt < effectiveMaxAttempts) await new Promise((resolveSleep) => setTimeout(resolveSleep, effectiveRetryDelayMs))
    }
  }

  safeLog(log, 'error', `[FAIL] ${service.name}: indisponível após ${effectiveMaxAttempts} tentativas`)
  return { ok: false, service: service.id, name: service.name, attempts: effectiveMaxAttempts, elapsedMs: null, failureCode: lastFailureCode }
}

/**
 * Backwards-compatible transport-only monitor helper retained for the original
 * WebSocket unit/integration tests and external local diagnostics.
 */
export async function monitorTarget(target, options = {}) {
  const {
    maxAttempts = 8,
    retryDelayMs = 10_000,
    connectTimeoutMs = 15_000,
    pongTimeoutMs = 15_000,
    log = console,
    check = checkWebSocket,
  } = options

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await check(target.url, { connectTimeoutMs, pongTimeoutMs })
      log.info?.(`[UP] ${target.name}: WebSocket Ping/Pong OK (${result.elapsedMs} ms; tentativa ${attempt}/${maxAttempts})`)
      return { ...result, ok: true, attempts: attempt }
    } catch {
      log.warn?.(`[DOWN] ${target.name}: WebSocket indisponível (tentativa ${attempt}/${maxAttempts})`)
      if (attempt < maxAttempts) await new Promise((resolveSleep) => setTimeout(resolveSleep, retryDelayMs))
    }
  }

  log.error?.(`[FAIL] ${target.name}: indisponível após ${maxAttempts} tentativas`)
  return { ok: false, attempts: maxAttempts }
}

export async function runMonitor(env = process.env, options = {}) {
  const log = options.log ?? console
  if (!parseBoolean(env.WS_MONITOR_ENABLED, true)) {
    safeLog(log, 'info', '[SKIP] WS_MONITOR_ENABLED desativou o monitor global.')
    return 0
  }

  const globalInterval = positiveInteger(env.WS_MONITOR_INTERVAL_MINUTES, 5)
  const eventName = env.GITHUB_EVENT_NAME
  const force = options.force ?? (!eventName || eventName === 'workflow_dispatch')
  const now = options.now ?? Date.now()
  const results = await Promise.all(SERVICES.map(async (service) => {
    const url = env[service.urlKey]
    const enabled = parseBoolean(env[service.enabledKey], Boolean(url))
    if (!enabled) {
      safeLog(log, 'info', `[SKIP] ${service.name}: desativado.`)
      return { service: service.id, name: service.name, status: 'disabled' }
    }

    const interval = positiveInteger(env[service.intervalKey], globalInterval)
    if (!force && !isIntervalDue(interval, now)) {
      return { service: service.id, name: service.name, status: 'not_due', intervalMinutes: interval }
    }

    if (!url) {
      safeLog(log, 'error', `[CONFIG] ${service.name}: URL não configurada; serviço habilitado.`)
      return { service: service.id, name: service.name, status: 'misconfigured', ok: false }
    }

    try {
      if (service.id === 'mcraft-p2p-peerjs') {
        const parsed = new URL(url)
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
          throw new Error('invalid endpoint')
        }
      } else {
        normalizeWebSocketUrl(url)
      }

      const probe = options.probes?.[service.id] ?? options.probe ?? service.probe
      return await runService(service, url, { ...options, log, probe })
    } catch {
      safeLog(log, 'error', `[CONFIG] ${service.name}: URL inválida.`)
      return { service: service.id, name: service.name, status: 'misconfigured', ok: false }
    }
  }))

  const checked = results.filter((result) => result.status === undefined)
  const passed = checked.filter((result) => result.ok).length
  const failed = results.filter((result) => result.ok === false).length
  const skipped = results.filter((result) => ['disabled', 'not_due'].includes(result.status)).length
  safeLog(log, 'info', `\nResultado: ${passed}/${checked.length} verificações aprovadas; ${failed} falhas; ${skipped} ignoradas.`)

  if (env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
    try {
      const published = await (options.publishHistory ?? publishGitHubHistory)(results, env, { now, fetchImpl: options.fetchImpl })
      safeLog(log, 'info', '[HISTORY] Incidentes e amostras de cada verificação sincronizados com GitHub Issues.')
      for (const batch of published.notifications ?? []) {
        for (const delivery of batch.results ?? []) {
          safeLog(log, delivery.ok ? 'info' : 'warn', `[NOTIFY] ${delivery.destination}: ${delivery.ok ? 'entregue' : 'falha na entrega'}.`)
        }
      }
    } catch {
      // Do not hide the actual relay result or leak API response bodies/secrets.
      safeLog(log, 'error', '[HISTORY] Não foi possível atualizar o histórico/notificações do GitHub.')
    }
  }

  return failed === 0 ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = {
    maxAttempts: positiveInteger(process.env.WS_MAX_ATTEMPTS, 8),
    retryDelayMs: positiveInteger(process.env.WS_RETRY_DELAY_MS, 10_000),
    timeoutMs: positiveInteger(process.env.WS_CONNECT_TIMEOUT_MS, 15_000),
  }

  runMonitor(process.env, options)
    .then((exitCode) => { process.exitCode = exitCode })
    .catch(() => {
      console.error('[FATAL] Falha inesperada no monitor.')
      process.exitCode = 1
    })
}
