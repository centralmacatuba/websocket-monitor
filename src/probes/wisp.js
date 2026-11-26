import { client as wisp } from '@mercuryworkshop/wisp-js/client'

/** Negotiate Wisp v2 through the same official client API used by the service tests. */
export function checkWisp(url, { timeoutMs = 15_000, ClientConnection = wisp.ClientConnection } = {}) {
  const parsed = new URL(url)
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Invalid Wisp WebSocket URL')
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const connection = new ClientConnection(parsed.toString(), { wisp_version: 2 })
    let settled = false
    const timer = setTimeout(() => finish(new Error('Wisp v2 negotiation timed out')), timeoutMs)

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
