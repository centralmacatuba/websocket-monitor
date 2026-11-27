import { randomBytes } from 'node:crypto'

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

export function parsePeerServerUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Invalid PeerJS endpoint')
  }
  return {
    host: url.hostname,
    port: Number(url.port) || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80),
    path: url.pathname.replace(/\/+$/, '') || '/peerjs',
    protocol: ['https:', 'wss:'].includes(url.protocol) ? 'https' : 'http',
    secure: ['https:', 'wss:'].includes(url.protocol),
    key: url.searchParams.get('key') || 'peerjs',
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('PeerJS returned a non-binary payload')
}

/** PeerJS-compatible registration and raw data-channel round-trip using the MWC-era API. */
export async function checkPeerJsInProcess(url, { timeoutMs = 15_000, PeerClass, installPolyfillImpl } = {}) {
  const startedAt = Date.now()
  const options = parsePeerServerUrl(url)

  // PeerJS is browser-first. Install werift's browser-compatible WebRTC globals
  // before importing PeerJS so its runtime feature detection sees the API.
  globalThis.window ??= globalThis
  const { installPolyfill } = installPolyfillImpl ? { installPolyfill: installPolyfillImpl } : await import('werift/polyfill')
  const uninstallPolyfill = installPolyfill({
    mediaRegister: [],
    peerConnectionConfig: { compatibility: 'standard', iceServers: [], iceUseDefaultStunServer: false },
  })
  let receiver
  let sender
  let incoming
  let outgoing

  try {
    const peerjsModule = PeerClass ? null : await import('peerjs')
    const Peer = PeerClass ?? [
      peerjsModule.Peer,
      peerjsModule.default?.Peer,
      peerjsModule.default,
    ].find((candidate) => typeof candidate === 'function')
    if (typeof Peer !== 'function') throw new Error('PeerJS client does not expose a Peer constructor')
    const peerOptions = { ...options, debug: 0, config: { iceServers: [], iceUseDefaultStunServer: false } }
    receiver = new Peer(undefined, peerOptions)
    sender = new Peer(undefined, peerOptions)

    const [receiverId] = await withTimeout(Promise.all([
      new Promise((resolveId, rejectId) => {
        receiver.once('open', resolveId)
        receiver.once('error', rejectId)
      }),
      new Promise((resolveId, rejectId) => {
        sender.once('open', resolveId)
        sender.once('error', rejectId)
      }),
    ]), timeoutMs, 'PeerJS registration timed out')

    const nonce = randomBytes(16).toString('hex')
    const payload = Buffer.from(`cm-monitor:${nonce}`)
    const ack = Buffer.from(`cm-monitor-ack:${nonce}`)

    const received = new Promise((resolveData, rejectData) => {
      receiver.once('connection', (connection) => {
        incoming = connection
        connection.once('error', rejectData)
        connection.on('data', (data) => {
            try {
              const bytes = toBuffer(data)
              if (!bytes.equals(payload)) return rejectData(new Error('PeerJS payload mismatch'))
              connection.send(ack)
              resolveData()
            } catch (error) { rejectData(error) }
        })
      })
    })
    // Mark early ICE/negotiation failures as handled while outgoing.open is pending.
    // Awaiting the original promise later still propagates the rejection.
    received.catch(() => {})

    outgoing = sender.connect(receiverId, { serialization: 'raw', reliable: true })
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      outgoing.once('open', resolveOpen)
      outgoing.once('error', rejectOpen)
    }), timeoutMs, 'PeerJS data connection timed out')

    const ackReceived = new Promise((resolveAck, rejectAck) => {
      outgoing.once('data', (data) => {
        try {
          if (!toBuffer(data).equals(ack)) throw new Error('PeerJS acknowledgement mismatch')
          resolveAck()
        } catch (error) { rejectAck(error) }
      })
      outgoing.once('error', rejectAck)
    })
    outgoing.send(payload)
    await withTimeout(Promise.all([received, ackReceived]), timeoutMs, 'PeerJS raw data exchange timed out')
    return { transport: true, protocol: true, registration: true, dataChannel: true, rawExchange: true, elapsedMs: Date.now() - startedAt }
  } finally {
    try { incoming?.close() } catch {}
    try { outgoing?.close() } catch {}
    try { sender?.destroy() } catch {}
    try { receiver?.destroy() } catch {}
    uninstallPolyfill()
  }
}


/**
 * Run the PeerJS probe in a disposable child process. PeerJS can resolve
 * retrieveId() after a timeout; process isolation guarantees late sockets and
 * heartbeat timers cannot keep the monitor alive or survive cleanup.
 */
export async function checkPeerJs(url, options = {}) {
  if (options.PeerClass || options.installPolyfillImpl) {
    return checkPeerJsInProcess(url, options)
  }

  const { fork } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'peerjs-worker.js')
  const timeoutMs = options.timeoutMs ?? 15_000
  const child = fork(workerPath, [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error('PeerJS probe process timed out')), timeoutMs + 2_000)
      const cleanup = () => clearTimeout(timer)
      child.once('message', (message) => {
        cleanup()
        if (message?.type === 'result') resolveResult(message.result)
        else rejectResult(new Error(message?.error || 'PeerJS probe process failed'))
      })
      child.once('error', (error) => { cleanup(); rejectResult(error) })
      child.once('exit', (code) => {
        cleanup()
        if (code !== 0) rejectResult(new Error('PeerJS probe process exited unexpectedly'))
      })
      child.send({ type: 'probe', url, timeoutMs })
    })
    return result
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
