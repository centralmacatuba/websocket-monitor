import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWebSocket, normalizeWebSocketUrl } from './check-websocket.js'
import { checkTrystero } from './probes/trystero.js'
import { checkEaglerRelay } from './probes/eaglercraft-relay.js'
import { checkPeerJs } from './probes/peerjs.js'
import { checkWisp } from './probes/wisp.js'

const SERVICES = [
  { id: 'trystero', name: 'Mcraft P2P (Trystero)', urlKey: 'MCRAFT_TRYSTERO_WS_URL', enabledKey: 'TRYSTERO_MONITOR_ENABLED', intervalKey: 'TRYSTERO_MONITOR_INTERVAL_MINUTES', probe: checkTrystero },
  { id: 'eaglercraft', name: 'EaglerCraft Relay', urlKey: 'EAGLERCRAFT_RELAY_WS_URL', enabledKey: 'EAGLERCRAFT_RELAY_MONITOR_ENABLED', intervalKey: 'EAGLERCRAFT_RELAY_MONITOR_INTERVAL_MINUTES', probe: checkEaglerRelay },
  { id: 'peerjs', name: 'Mcraft P2P (PeerJS legado)', urlKey: 'PEERJS_WS_URL', enabledKey: 'PEERJS_MONITOR_ENABLED', intervalKey: 'PEERJS_MONITOR_INTERVAL_MINUTES', probe: checkPeerJs },
  { id: 'wisp', name: 'EaglerCraft Wisp v2', urlKey: 'WISP_WS_URL', enabledKey: 'WISP_MONITOR_ENABLED', intervalKey: 'WISP_MONITOR_INTERVAL_MINUTES', probe: checkWisp },
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
  return minute % effectiveInterval === 0
}

function safeLog(log, level, message) {
  log[level]?.(message)
}

async function runService(service, url, options) {
  const {
    maxAttempts = 8,
    retryDelayMs = 10_000,
    timeoutMs = 15_000,
    log = console,
    probe = service.probe,
  } = options

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await probe(url, { timeoutMs })
      safeLog(log, 'info', `[UP] ${service.name}: transporte + protocolo OK (${result.elapsedMs ?? 0} ms; tentativa ${attempt}/${maxAttempts})`)
      return { ok: true, service: service.id, name: service.name, attempts: attempt, ...result }
    } catch {
      safeLog(log, 'warn', `[DOWN] ${service.name}: falha de protocolo/transporte (tentativa ${attempt}/${maxAttempts})`)
      if (attempt < maxAttempts) await new Promise((resolveSleep) => setTimeout(resolveSleep, retryDelayMs))
    }
  }

  safeLog(log, 'error', `[FAIL] ${service.name}: indisponível após ${maxAttempts} tentativas`)
  return { ok: false, service: service.id, name: service.name, attempts: maxAttempts }
}

/**
 * Run only the services enabled by environment configuration and due at this
 * scheduler tick. The GitHub schedule is minute-granular; service intervals are
 * calculated independently against UTC epoch minutes. Manual/local runs force
 * all enabled services to execute.
 */
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
      // Reject malformed URLs before entering retries. PeerJS accepts HTTP(S)
      // and WS(S) URLs; the other probes require WebSocket URLs.
      if (service.id === 'peerjs') {
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
