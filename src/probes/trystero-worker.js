import { joinRoom } from '@trystero-p2p/ws-relay'
import { RTCPeerConnection } from 'werift'

const url = process.env.CM_TRYSTERO_URL
const roomId = process.env.CM_TRYSTERO_ROOM
const timeoutMs = Number(process.env.CM_TRYSTERO_TIMEOUT) || 15_000
let room

async function main() {
  room = joinRoom({
    appId: 'prismarine-web-client',
    identity: 'none',
    maxUsers: 2,
    rtcPolyfill: RTCPeerConnection,
    relayConfig: { urls: [url], warnOnRelayFailure: false },
  }, roomId)
  const [send, onMessage] = room.makeAction('cm-monitor-health')
  const timer = setTimeout(() => process.exit(2), timeoutMs)
  onMessage(async (message) => {
    if (message?.kind !== 'probe' || typeof message.nonce !== 'string') return
    await send({ kind: 'ack', nonce: message.nonce })
    clearTimeout(timer)
    await room.leave()
    if (process.connected) process.send({ type: 'done' })
    process.exit(0)
  })
  await room.ready
  if (process.connected) process.send({ type: 'ready' })
  process.on('message', async (message) => {
    if (message?.type === 'stop') {
      clearTimeout(timer)
      await room.leave()
      process.exit(0)
    }
  })
}

main().catch(async () => {
  if (room) await room.leave().catch(() => {})
  if (process.connected) process.send({ type: 'error' })
  process.exit(2)
})
