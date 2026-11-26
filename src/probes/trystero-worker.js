import { joinRoom } from '@trystero-p2p/ws-relay'
import { RTCPeerConnection } from 'werift'

const url = process.env.CM_TRYSTERO_URL
const roomId = process.env.CM_TRYSTERO_ROOM
const timeoutMs = Number(process.env.CM_TRYSTERO_TIMEOUT) || 15_000
let room
let cleanupPromise

function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      clearTimeout(timer)
      if (room) await room.leave().catch(() => {})
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
  action.onMessage(async (message) => {
    if (message?.kind !== 'probe' || typeof message.nonce !== 'string') return
    await action.send({ kind: 'ack', nonce: message.nonce })
    await cleanup()
    if (process.connected) process.send({ type: 'done' })
    process.exit(0)
  })
  process.on('message', async (message) => {
    if (message?.type === 'stop') {
      await cleanup()
      process.exit(0)
    }
  })
  await room.ready
  if (process.connected) process.send({ type: 'ready' })
}

main().catch(async () => {
  await cleanup()
  if (process.connected) process.send({ type: 'error' })
  process.exit(2)
})
