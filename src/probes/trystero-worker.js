import { joinRoom } from '@trystero-p2p/ws-relay'
import { RTCPeerConnection } from 'werift'

const role = process.env.CM_TRYSTERO_ROLE || 'responder'
const startedAt = Date.now()
const url = process.env.CM_TRYSTERO_URL
const roomId = process.env.CM_TRYSTERO_ROOM
const timeoutMs = Number(process.env.CM_TRYSTERO_TIMEOUT) || 15_000
let room
let cleanupPromise

function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      clearTimeout(timer)
      if (room) { try { await room.leave() } catch {} }
    })()
  }
  return cleanupPromise
}

const timer = setTimeout(async () => {
  await cleanup()
  process.exit(2)
}, timeoutMs)

async function main() {
  room = joinRoom({
    appId: 'centralmacatuba-websocket-monitor',
    identity: 'none',
    maxUsers: 2,
    rtcPolyfill: RTCPeerConnection,
    rtcConfig: { iceServers: [], iceUseDefaultStunServer: false },
    relayConfig: { urls: [url], warnOnRelayFailure: false },
  }, roomId)
  const action = room.makeAction('cm-monitor-health')
  if (role === 'initiator') {
    let settled = false
    const nonce = process.env.CM_TRYSTERO_NONCE
    const finish = async (error) => {
      if (settled) return
      settled = true
      await cleanup()
      if (process.connected) process.send(error ? { type: 'error' } : { type: 'done', elapsedMs: Date.now() - startedAt })
      process.exit(error ? 2 : 0)
    }
    action.onMessage = (message) => {
      if (message?.kind === 'ack' && message.nonce === nonce) void finish()
    }
    room.onPeerJoin = async () => {
      try { await action.send({ kind: 'probe', nonce }) } catch (error) { await finish(error) }
    }
  } else {
    action.onMessage = async (message) => {
      if (message?.kind !== 'probe' || typeof message.nonce !== 'string') return
      await action.send({ kind: 'ack', nonce: message.nonce })
      await cleanup()
      if (process.connected) process.send({ type: 'done' })
      process.exit(0)
    }
  }
  process.on('message', async (message) => {
    if (message?.type === 'stop') {
      await cleanup()
      process.exit(0)
    }
  })
  if (process.connected) process.send({ type: 'ready' })
}

main().catch(async () => {
  await cleanup()
  if (process.connected) process.send({ type: 'error' })
  process.exit(2)
})
