import { randomBytes } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { joinRoom } from '@trystero-p2p/ws-relay'
import { RTCPeerConnection } from 'werift'

const APP_ID = 'prismarine-web-client'
const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'trystero-worker.js')

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Start two isolated Trystero clients (separate Node processes) in an ephemeral
 * room, then validate an action round-trip. The signaling URL is the same relay
 * endpoint configured by the Mcraft client. No TURN credentials are required.
 */
export async function checkTrystero(url, { timeoutMs = 15_000 } = {}) {
  const roomId = `cm-monitor-${randomBytes(18).toString('hex')}`
  const nonce = randomBytes(18).toString('hex')
  const startedAt = Date.now()
  const child = fork(workerPath, [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      CM_TRYSTERO_ROLE: 'responder',
      CM_TRYSTERO_URL: url,
      CM_TRYSTERO_ROOM: roomId,
      CM_TRYSTERO_TIMEOUT: String(timeoutMs),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let room
  let settled = false

  try {
    const childReady = withTimeout(new Promise((resolveReady, rejectReady) => {
      child.once('message', (message) => message?.type === 'ready' ? resolveReady() : rejectReady(new Error('Trystero worker failed to initialize')))
      child.once('error', rejectReady)
      child.once('exit', (code) => { if (code !== 0) rejectReady(new Error('Trystero worker exited during startup')) })
    }), timeoutMs, 'Trystero peer startup timed out')

    room = joinRoom({
      appId: APP_ID,
      identity: 'none',
      maxUsers: 2,
      rtcPolyfill: RTCPeerConnection,
      relayConfig: { urls: [url], warnOnRelayFailure: false },
    }, roomId)
    const [send, onMessage] = room.makeAction('cm-monitor-health')

    const ack = withTimeout(new Promise((resolveAck, rejectAck) => {
      const timer = setTimeout(() => rejectAck(new Error('Trystero peer exchange timed out')), timeoutMs)
      onMessage((message) => {
        if (message?.kind === 'ack' && message.nonce === nonce) {
          clearTimeout(timer)
          resolveAck()
        }
      })
      room.onUserJoin(async () => {
        try { await send({ kind: 'probe', nonce }) } catch (error) { rejectAck(error) }
      })
      child.once('exit', (code) => {
        if (code !== 0) rejectAck(new Error('Trystero worker exited before acknowledgement'))
      })
    }), timeoutMs + 1_000, 'Trystero peer exchange timed out')

    await Promise.all([room.ready, childReady])
    await ack
    settled = true
    return { transport: true, protocol: true, peerExchange: true, elapsedMs: Date.now() - startedAt }
  } finally {
    if (room) await room.leave().catch(() => {})
    if (child.connected) child.send({ type: 'stop' })
    if (child.exitCode === null) child.kill()
    void settled
  }
}
