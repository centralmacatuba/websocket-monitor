import { client as wisp } from '@mercuryworkshop/wisp-js/client'

function makeClientEndpoint(parsed) {
  const endpoint = parsed.toString()
  if (!parsed.search) return endpoint

  // wisp-js 0.5.3 checks String.endsWith('/') on the entire URL, which
  // incorrectly rejects valid URLs whose query follows a slash-terminated path.
  // Keep the original URL for WebSocket coercion while satisfying that legacy
  // path check without changing or dropping query parameters.
  const compatible = new String(endpoint)
  Object.defineProperty(compatible, 'endsWith', {
    value: (suffix, ...args) => suffix === '/'
      ? parsed.pathname.endsWith('/')
      : String.prototype.endsWith.call(endpoint, suffix, ...args),
  })
  return compatible
}

/** Negotiate Wisp v2 through the official client while preserving URL queries. */
export function checkWisp(url, { timeoutMs = 15_000, ClientConnection = wisp.ClientConnection } = {}) {
  const parsed = new URL(url)
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Invalid Wisp WebSocket URL')
  }

  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  const clientUrl = makeClientEndpoint(parsed)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const connection = new ClientConnection(clientUrl, { wisp_version: 2 })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { connection.close() } catch {}
      if (error) reject(error)
      else resolve({
        transport: true,
        protocol: true,
        wispVersion: connection.wisp_version,
        motdReceived: typeof connection.server_motd === 'string',
        elapsedMs: Date.now() - startedAt,
      })
    }

    // The upstream client's v2 error handler automatically retries as v1.
    // Override it so a v1 fallback cannot outlive a timed-out/failed v2 probe.
    if (connection.ws) {
      connection.ws.onerror = () => {
        try { connection.cleanup?.() } catch {}
        connection.onerror?.()
      }
      const originalOnMessage = connection.ws.onmessage
      if (typeof originalOnMessage === 'function') {
        connection.ws.onmessage = function (event) {
          try { return originalOnMessage.call(this, event) }
          catch (error) { finish(error) }
        }
      }
    }

    const timer = setTimeout(() => finish(new Error('Wisp v2 negotiation timed out')), timeoutMs)
    connection.onopen = () => {
      if (connection.wisp_version !== 2) {
        finish(new Error('Wisp server did not negotiate protocol version 2'))
        return
      }
      finish()
    }
    connection.onerror = () => finish(new Error('Wisp WebSocket or protocol error'))
    connection.onclose = () => {
      if (!settled) finish(new Error('Wisp connection closed before v2 negotiation completed'))
    }
  })
}
