import { randomBytes } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { joinRoom } from '@trystero-p2p/ws-relay'
import { RTCPeerConnection } from 'werift'

const APP_ID = 'centralmacatuba-websocket-monitor'
const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'trystero-worker.js')

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  if (child.connected) child.send({ type: 'stop' })
  await Promise.race([exited, delay(1_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await Promise.race([exited, delay(1_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

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
async function checkTrysteroInProcess(url, { timeoutMs = 15_000, joinRoomImpl = joinRoom, forkImpl = fork } = {}) {
  const roomId = `cm-monitor-${randomBytes(18).toString('hex')}`
  const nonce = randomBytes(18).toString('hex')
  const startedAt = Date.now()
  const child = forkImpl(workerPath, [], {
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
  let childReadyTimer

  try {
    let rejectChildReady
    const childReady = new Promise((resolveReady, rejectReady) => {
      rejectChildReady = rejectReady
      child.once('message', (message) => message?.type === 'ready' ? resolveReady() : rejectReady(new Error('Trystero worker failed to initialize')))
      child.once('error', rejectReady)
      child.once('exit', (code) => { if (code !== 0) rejectReady(new Error('Trystero worker exited during startup')) })
    })
    // Attach a rejection observer immediately because room creation can fail before startup is awaited.
    childReady.catch(() => {})
    childReadyTimer = setTimeout(() => rejectChildReady(new Error('Trystero peer startup timed out')), timeoutMs)

    room = joinRoomImpl({
      appId: APP_ID,
      identity: 'none',
      maxUsers: 2,
      rtcPolyfill: RTCPeerConnection,
      rtcConfig: { iceServers: [], iceUseDefaultStunServer: false },
      relayConfig: { urls: [url], warnOnRelayFailure: false },
    }, roomId)
    const action = room.makeAction('cm-monitor-health')

    let resolveAck, rejectAck
    let ackSettled = false
    const ackPromise = new Promise((resolve, reject) => {
      resolveAck = resolve
      rejectAck = reject
    })
    // Observe failures immediately: startup can fail before the ACK is awaited.
    ackPromise.catch(() => {})
    const settleAck = (error) => {
      if (ackSettled) return
      ackSettled = true
      if (error) rejectAck(error)
      else resolveAck()
    }
    const onChildExit = (code) => {
      if (code !== 0) settleAck(new Error('Trystero worker exited before acknowledgement'))
    }
    child.once('exit', onChildExit)
    action.onMessage = (message) => {
      if (message?.kind === 'ack' && message.nonce === nonce) settleAck()
    }
    room.onPeerJoin = async () => {
      try { await action.send({ kind: 'probe', nonce }) } catch (error) { settleAck(error) }
    }

    try {
      await childReady
      await withTimeout(ackPromise, timeoutMs, 'Trystero peer exchange timed out')
    } finally {
      child.off('exit', onChildExit)
      action.onMessage = null
      room.onPeerJoin = null
    }
    return { transport: true, protocol: true, peerExchange: true, elapsedMs: Date.now() - startedAt }
  } finally {
    clearTimeout(childReadyTimer)
    if (room) { try { await room.leave() } catch {} }
    await stopChild(child)
  }
}


/** Run both Trystero relay clients in disposable processes, including the initiator. */
export async function checkTrystero(url, options = {}) {
  if (options.joinRoomImpl) return checkTrysteroInProcess(url, options)

  const timeoutMs = options.timeoutMs ?? 15_000
  const forkImpl = options.forkImpl ?? fork
  const roomId = `cm-monitor-${randomBytes(18).toString('hex')}`
  const nonce = randomBytes(18).toString('hex')
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'trystero-worker.js')
  const children = ['responder', 'initiator'].map((role) => forkImpl(workerPath, [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      CM_TRYSTERO_ROLE: role,
      CM_TRYSTERO_URL: url,
      CM_TRYSTERO_ROOM: roomId,
      CM_TRYSTERO_NONCE: nonce,
      CM_TRYSTERO_TIMEOUT: String(timeoutMs),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }))

  const waitFor = (child, expected, message) => new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error(message)), timeoutMs)
    const cleanup = () => clearTimeout(timer)
    child.on('message', (value) => {
      if (value?.type === expected) { cleanup(); resolveWait(value) }
      else if (value?.type === 'error') { cleanup(); rejectWait(new Error('Trystero worker failed')) }
    })
    child.once('error', (error) => { cleanup(); rejectWait(error) })
    child.once('exit', (code) => { if (code !== 0) { cleanup(); rejectWait(new Error('Trystero worker exited unexpectedly')) } })
  })

  try {
    const donePromise = waitFor(children[1], 'done', 'Trystero peer exchange timed out')
    donePromise.catch(() => {})
    const readyPromise = Promise.all(children.map((child) => waitFor(child, 'ready', 'Trystero peer startup timed out')))
    const [, result] = await Promise.all([readyPromise, donePromise])
    return { transport: true, protocol: true, peerExchange: true, elapsedMs: result.elapsedMs }
  } finally {
    await Promise.all(children.map((child) => stopChild(child)))
  }
}
