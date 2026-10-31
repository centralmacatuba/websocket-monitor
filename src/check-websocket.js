import WebSocket from 'ws'

/**
 * Validate and normalize a WebSocket endpoint without exposing URL credentials.
 * Only ws:// and wss:// endpoints are accepted.
 */
export function normalizeWebSocketUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('WebSocket URL is missing')
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('WebSocket URL is invalid')
  }

  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('WebSocket URL must use ws:// or wss://')
  }

  if (!url.hostname || url.username || url.password || url.hash) {
    throw new Error('WebSocket URL contains unsupported or unsafe components')
  }

  return url.toString()
}

/**
 * Open a real WebSocket connection, verify the handshake, send a protocol-level
 * Ping frame, and require the server's Pong response.
 *
 * This validates the WebSocket transport and control-frame handling. It does not
 * perform an application-specific Trystero or EaglerCraft game-protocol exchange.
 */
export function checkWebSocket(value, {
  connectTimeoutMs = 15_000,
  pongTimeoutMs = 5_000,
  closeTimeoutMs = 1_000,
  WebSocketClass = WebSocket,
} = {}) {
  const url = normalizeWebSocketUrl(value)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let settled = false
    let opened = false
    let connectTimer
    let pongTimer
    let closeTimer

    const socket = new WebSocketClass(url, {
      handshakeTimeout: connectTimeoutMs,
      perMessageDeflate: false,
      followRedirects: false,
    })

    const cleanupTimers = () => {
      clearTimeout(connectTimer)
      clearTimeout(pongTimer)
      clearTimeout(closeTimer)
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanupTimers()
      socket.terminate()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    connectTimer = setTimeout(() => {
      fail(new Error(`WebSocket handshake timed out after ${connectTimeoutMs} ms`))
    }, connectTimeoutMs + 250)

    socket.once('open', () => {
      opened = true
      clearTimeout(connectTimer)

      pongTimer = setTimeout(() => {
        fail(new Error(`WebSocket connected but did not answer Ping within ${pongTimeoutMs} ms`))
      }, pongTimeoutMs)

      try {
        socket.ping()
      } catch (error) {
        fail(new Error(`Unable to send WebSocket Ping: ${error.message}`))
      }
    })

    socket.once('pong', () => {
      if (settled) return
      settled = true
      cleanupTimers()

      socket.once('close', () => clearTimeout(closeTimer))
      closeTimer = setTimeout(() => socket.terminate(), closeTimeoutMs)
      closeTimer.unref?.()

      try {
        socket.close(1000, 'Central Macatuba monitor check')
      } catch {
        socket.terminate()
      }

      resolve({
        ok: true,
        handshake: true,
        pong: true,
        elapsedMs: Date.now() - startedAt,
      })
    })

    socket.once('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode
      response.resume()
      fail(new Error(`WebSocket handshake rejected with HTTP ${statusCode ?? 'unknown'}`))
    })

    socket.on('error', (error) => {
      if (!settled) {
        fail(new Error(`WebSocket connection failed: ${error.message}`))
      }
    })

    socket.once('close', (code, reason) => {
      if (!settled) {
        const detail = reason?.toString() || 'no close reason'
        fail(new Error(opened
          ? `WebSocket closed before Pong (code ${code}: ${detail})`
          : `WebSocket closed before handshake completed (code ${code}: ${detail})`))
      }
    })
  })
}
