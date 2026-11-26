import { randomBytes } from 'node:crypto'

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

function parsePeerServerUrl(value) {
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
export async function checkPeerJs(url, { timeoutMs = 15_000 } = {}) {
  const startedAt = Date.now()
  const options = parsePeerServerUrl(url)

  // PeerJS is browser-first. Install werift's browser-compatible WebRTC globals
  // before importing PeerJS so its runtime feature detection sees the API.
  globalThis.window ??= globalThis
  const { installPolyfill } = await import('werift/polyfill')
  const uninstallPolyfill = installPolyfill({
    mediaRegister: [],
    peerConnectionConfig: { compatibility: 'standard', iceServers: [], iceUseDefaultStunServer: false },
  })
  let receiver
  let sender
  let incoming
  let outgoing

  try {
    const { Peer } = await import('peerjs')
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
