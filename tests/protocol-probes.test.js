import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { test } from 'node:test'
import { checkEaglerRelay, createEaglerPingPacket, parseEaglerPong } from '../src/probes/eaglercraft-relay.js'
import { parsePeerServerUrl } from '../src/probes/peerjs.js'
import { checkWisp } from '../src/probes/wisp.js'
import { checkPeerJs } from '../src/probes/peerjs.js'
import { checkTrystero } from '../src/probes/trystero.js'

function ascii8(value) {
  const bytes = Buffer.from(value, 'latin1')
  assert.ok(bytes.length <= 255)
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

test('builds the EaglerSPRelay v1 ping handshake packet', () => {
  assert.deepEqual(createEaglerPingPacket(), Buffer.from([0x00, 0x03, 0x01, 0x00]))
})

test('parses the EaglerSPRelay pong packet and metadata', () => {
  const packet = Buffer.concat([Buffer.from([0x69, 0x01]), ascii8('status'), ascii8('relay-brand')])
  assert.deepEqual(parseEaglerPong(packet), {
    protocolVersion: 1,
    comment: 'status',
    brand: 'relay-brand',
  })
})

test('rejects unexpected, truncated, and incompatible EaglerSPRelay responses', () => {
  assert.throws(() => parseEaglerPong(Buffer.from([0x01, 0x01])), /Unexpected/)
  assert.throws(() => parseEaglerPong(Buffer.from([0x69, 0x02])), /Unsupported/)
  assert.throws(() => parseEaglerPong(Buffer.from([0x69, 0x01, 0x00])), /Truncated/)
})


test('parses PeerJS server endpoints into client options', () => {
  assert.deepEqual(parsePeerServerUrl('wss://peer.example.test:8443/peerjs/?key=cm-key'), {
    host: 'peer.example.test',
    port: 8443,
    path: '/peerjs',
    protocol: 'https',
    secure: true,
    key: 'cm-key',
  })
  assert.deepEqual(parsePeerServerUrl('https://peer.example.test'), {
    host: 'peer.example.test',
    port: 443,
    path: '/peerjs',
    protocol: 'https',
    secure: true,
    key: 'peerjs',
  })
  assert.throws(() => parsePeerServerUrl('https://user:password@peer.example.test/peerjs'), /Invalid/)
})

test('negotiates Wisp v2 with the official client API', async () => {
  class FakeClientConnection {
    constructor(url, options) {
      assert.equal(url, 'wss://wisp.example.test/wisp/')
      assert.deepEqual(options, { wisp_version: 2 })
      this.wisp_version = 2
      this.server_motd = 'test'
      queueMicrotask(() => this.onopen?.())
    }
    close() {}
  }
  const result = await checkWisp('wss://wisp.example.test/wisp/', { ClientConnection: FakeClientConnection })
  assert.equal(result.protocol, true)
  assert.equal(result.wispVersion, 2)
  assert.equal(result.motdReceived, true)
})

test('rejects a Wisp INFO packet that advertises a protocol version other than v2', async () => {
  class IncompatibleInfoConnection {
    constructor() {
      this.wisp_version = 2
      this.ws = {
        onmessage: (event) => {
          const bytes = new Uint8Array(event.data)
          if (bytes[0] === 0x05) this.onopen?.()
        },
      }
      queueMicrotask(() => this.ws.onmessage({ data: new Uint8Array([0x05, 0, 0, 0, 0, 3, 0]).buffer }))
    }
    close() {}
  }
  await assert.rejects(
    checkWisp('wss://wisp.example.test/wisp/', { ClientConnection: IncompatibleInfoConnection }),
    /incompatible protocol version/,
  )
})

test('preserves Wisp query parameters while normalizing the endpoint pathname', async () => {
  class QueryClientConnection {
    constructor(url, options) {
      assert.equal(String(url), 'wss://wisp.example.test/wisp/?token=private-test')
      assert.equal(url.endsWith('/'), true)
      assert.deepEqual(options, { wisp_version: 2 })
      this.wisp_version = 2
      queueMicrotask(() => this.onopen?.())
    }
    close() {}
  }
  await checkWisp('wss://wisp.example.test/wisp?token=private-test', { ClientConnection: QueryClientConnection })
})

test('routes exceptions from the Wisp WebSocket message handler into probe failure', async () => {
  class ThrowingMessageConnection {
    constructor() {
      this.wisp_version = 2
      this.ws = { onmessage: () => { throw new Error('malformed Wisp frame') } }
      queueMicrotask(() => this.ws.onmessage({ data: new Uint8Array([3, 0, 0, 0, 0]) }))
    }
    close() {}
  }
  await assert.rejects(
    checkWisp('wss://wisp.example.test/wisp/', { ClientConnection: ThrowingMessageConnection }),
    /malformed Wisp frame/,
  )
})

test('does not let the Wisp client silently reconnect using v1 after a v2 error', async () => {
  let fallbackAttempts = 0
  class FallbackConnection {
    constructor() {
      this.wisp_version = 2
      this.ws = { onerror: () => { fallbackAttempts += 1 } }
      queueMicrotask(() => this.ws.onerror?.())
    }
    cleanup() {}
    close() {}
  }
  await assert.rejects(
    checkWisp('wss://wisp.example.test/wisp/', { ClientConnection: FallbackConnection }),
    /Wisp WebSocket or protocol error/,
  )
  assert.equal(fallbackAttempts, 0)
})

test('rejects Wisp downgrade and negotiation timeout', async () => {
  class DowngradeConnection {
    constructor() {
      this.wisp_version = 1
      queueMicrotask(() => this.onopen?.())
    }
    close() {}
  }
  await assert.rejects(checkWisp('wss://wisp.example.test/wisp/', { ClientConnection: DowngradeConnection }), /version 2/)

  class SilentConnection { close() {} }
  await assert.rejects(checkWisp('wss://wisp.example.test/wisp/', { timeoutMs: 5, ClientConnection: SilentConnection }), /timed out/)
})

test('converts synchronous Eagler ping send errors into probe failures', async () => {
  class ThrowingSocket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')) }
    send() { throw new Error('simulated send failure') }
    terminate() {}
    close() {}
  }
  await assert.rejects(checkEaglerRelay('wss://relay.example.test', { WebSocketClass: ThrowingSocket }), /ping could not be sent/)
})

test('normalizes Wisp endpoint paths with a trailing slash', async () => {
  class FakeClientConnection {
    constructor(url) { assert.equal(url, 'wss://wisp.example.test/wisp/'); this.wisp_version = 2; queueMicrotask(() => this.onopen?.()) }
    close() {}
  }
  await checkWisp('wss://wisp.example.test/wisp', { ClientConnection: FakeClientConnection })
})

test('completes an EaglerSPRelay v1 ping round-trip against a local WebSocket server', async () => {
  const server = createServer()
  const websocketServer = new WebSocketServer({ server })
  websocketServer.on('connection', (socket) => {
    socket.on('message', (packet) => {
      assert.deepEqual(Buffer.from(packet), Buffer.from([0x00, 0x03, 0x01, 0x00]))
      const comment = ascii8('local test relay')
      const brand = ascii8('EaglerSPRelay')
      socket.send(Buffer.concat([Buffer.from([0x69, 0x01]), comment, brand]))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    const result = await checkEaglerRelay(`ws://127.0.0.1:${address.port}/`, { timeoutMs: 2_000 })
    assert.equal(result.transport, true)
    assert.equal(result.protocol, true)
    assert.equal(result.protocolVersion, 1)
  } finally {
    await new Promise((resolve) => websocketServer.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  }
})

function makeFakePeerHarness({ corruptPayload = false, openConnections = true, openPeers = true } = {}) {
  class FakeConnection extends EventEmitter {
    close() { this.closed = true }
    send(data) {
      if (this.remote) this.remote.emit('data', corruptPayload && data.toString().startsWith('cm-monitor:') ? Buffer.from('invalid') : data)
    }
  }
  class FakePeer extends EventEmitter {
    static instances = []
    constructor() {
      super()
      this.id = `peer-${FakePeer.instances.length}`
      FakePeer.instances.push(this)
      if (openPeers) queueMicrotask(() => this.emit('open', this.id))
    }
    connect(receiverId) {
      const receiver = FakePeer.instances.find((peer) => peer.id === receiverId)
      const outgoing = new FakeConnection()
      const incoming = new FakeConnection()
      outgoing.remote = incoming
      incoming.remote = outgoing
      this.outgoing = outgoing
      receiver.incoming = incoming
      if (openConnections) queueMicrotask(() => {
        receiver.emit('connection', incoming)
        incoming.emit('open')
        outgoing.emit('open')
      })
      return outgoing
    }
    destroy() { this.destroyed = true }
  }
  return { FakePeer, FakeConnection }
}

test('PeerJS completes registration and raw binary ACK with injected clients', async () => {
  const { FakePeer } = makeFakePeerHarness()
  let uninstalled = 0
  const result = await checkPeerJs('https://peer.example.test/peerjs', {
    PeerClass: FakePeer,
    installPolyfillImpl: () => () => { uninstalled += 1 },
    timeoutMs: 100,
  })
  assert.equal(result.registration, true)
  assert.equal(result.rawExchange, true)
  assert.equal(FakePeer.instances.length, 2)
  assert.ok(FakePeer.instances.every((peer) => peer.destroyed))
  assert.equal(uninstalled, 1)
})

test('PeerJS rejects invalid raw payloads and always destroys peers', async () => {
  const { FakePeer } = makeFakePeerHarness({ corruptPayload: true })
  let uninstalled = 0
  await assert.rejects(checkPeerJs('https://peer.example.test/peerjs', {
    PeerClass: FakePeer,
    installPolyfillImpl: () => () => { uninstalled += 1 },
    timeoutMs: 100,
  }), /payload mismatch/)
  assert.ok(FakePeer.instances.every((peer) => peer.destroyed))
  assert.equal(uninstalled, 1)
})

test('PeerJS registration timeout still uninstalls WebRTC and destroys created peers', async () => {
  const { FakePeer } = makeFakePeerHarness({ openPeers: false })
  let uninstalled = 0
  await assert.rejects(checkPeerJs('https://peer.example.test/peerjs', {
    PeerClass: FakePeer,
    installPolyfillImpl: () => () => { uninstalled += 1 },
    timeoutMs: 5,
  }), /registration timed out/)
  assert.ok(FakePeer.instances.every((peer) => peer.destroyed))
  assert.equal(uninstalled, 1)
})

function makeTrysteroHarness({ peerJoins = true, validAck = true, joinFails = false } = {}) {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.connected = true
  child.send = (message) => {
    if (message?.type === 'stop') {
      child.connected = false
      child.exitCode = 0
      queueMicrotask(() => child.emit('exit', 0, null))
    }
  }
  child.kill = () => {
    child.signalCode = 'SIGTERM'
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
  }
  queueMicrotask(() => child.emit('message', { type: 'ready' }))
  let left = 0
  let actionMessage
  const action = {
    set onMessage(callback) { actionMessage = callback },
    get onMessage() { return actionMessage },
    send: async (message) => actionMessage?.({ kind: 'ack', nonce: validAck ? message.nonce : 'wrong-nonce' }),
  }
  const room = {
    makeAction: () => action,
    set onPeerJoin(callback) { if (callback && peerJoins) queueMicrotask(() => callback('remote-peer')) },
    leave: async () => { left += 1 },
  }
  return {
    child,
    room,
    get leaveCount() { return left },
    joinRoomImpl: () => { if (joinFails) throw new Error('join failed'); return room },
    forkImpl: () => child,
  }
}

test('Trystero validates the ephemeral peer ACK and cleans up both participants', async () => {
  const harness = makeTrysteroHarness()
  const result = await checkTrystero('wss://relay.example.test', { timeoutMs: 100, joinRoomImpl: harness.joinRoomImpl, forkImpl: harness.forkImpl })
  assert.equal(result.peerExchange, true)
  assert.equal(harness.leaveCount, 1)
  assert.equal(harness.child.exitCode, 0)
})

test('Trystero fails when no peer joins and still cleans up', async () => {
  const harness = makeTrysteroHarness({ peerJoins: false })
  await assert.rejects(checkTrystero('wss://relay.example.test', { timeoutMs: 5, joinRoomImpl: harness.joinRoomImpl, forkImpl: harness.forkImpl }), /timed out/)
  assert.equal(harness.leaveCount, 1)
  assert.equal(harness.child.exitCode, 0)
})

test('Trystero rejects an invalid acknowledgement and cleans up', async () => {
  const harness = makeTrysteroHarness({ validAck: false })
  await assert.rejects(checkTrystero('wss://relay.example.test', { timeoutMs: 5, joinRoomImpl: harness.joinRoomImpl, forkImpl: harness.forkImpl }), /timed out/)
  assert.equal(harness.leaveCount, 1)
  assert.equal(harness.child.exitCode, 0)
})

test('Trystero cleans up the worker when room initialization fails', async () => {
  const harness = makeTrysteroHarness({ joinFails: true })
  await assert.rejects(checkTrystero('wss://relay.example.test', { timeoutMs: 100, joinRoomImpl: harness.joinRoomImpl, forkImpl: harness.forkImpl }), /join failed/)
  assert.equal(harness.leaveCount, 0)
  assert.equal(harness.child.exitCode, 0)
})

test('EaglerSPRelay rejects an early server disconnect and cleans up', async () => {
  const server = createServer()
  const websocketServer = new WebSocketServer({ server })
  websocketServer.on('connection', (socket) => socket.close(1000, 'test disconnect'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await assert.rejects(checkEaglerRelay(`ws://127.0.0.1:${address.port}/`, { timeoutMs: 500 }), /closed before protocol response/)
  } finally {
    await new Promise((resolve) => websocketServer.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  }
})

test('EaglerSPRelay times out when the server never answers the protocol ping', async () => {
  const server = createServer()
  const websocketServer = new WebSocketServer({ server })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await assert.rejects(checkEaglerRelay(`ws://127.0.0.1:${address.port}/`, { timeoutMs: 20 }), /protocol timed out/)
  } finally {
    await new Promise((resolve) => websocketServer.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  }
})

test('PeerJS data-channel timeout still closes connections and destroys peers', async () => {
  const { FakePeer } = makeFakePeerHarness({ openConnections: false })
  let uninstalled = 0
  await assert.rejects(checkPeerJs('https://peer.example.test/peerjs', {
    PeerClass: FakePeer,
    installPolyfillImpl: () => () => { uninstalled += 1 },
    timeoutMs: 5,
  }), /data connection timed out/)
  assert.ok(FakePeer.instances.every((peer) => peer.destroyed))
  assert.equal(uninstalled, 1)
})

test('Wisp disconnect before negotiation is a failure and closes the client', async () => {
  let closeCount = 0
  class DisconnectingConnection {
    constructor() { queueMicrotask(() => this.onclose?.()) }
    close() { closeCount += 1 }
  }
  await assert.rejects(checkWisp('wss://wisp.example.test/wisp/', { ClientConnection: DisconnectingConnection }), /closed before v2 negotiation/)
  assert.equal(closeCount, 1)
})


test('PeerJS production wrapper returns the isolated worker result and terminates its process', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.connected = true
  child.send = (message) => {
    assert.equal(message.type, 'probe')
    assert.equal(message.url, 'https://peer.example.test/peerjs')
    queueMicrotask(() => child.emit('message', { type: 'result', result: { protocol: true, elapsedMs: 10 } }))
  }
  child.kill = (signal) => { child.signalCode = signal }
  const result = await checkPeerJs('https://peer.example.test/peerjs', { timeoutMs: 100, forkImpl: () => child })
  assert.deepEqual(result, { protocol: true, elapsedMs: 10 })
  assert.equal(child.signalCode, 'SIGKILL')
})

test('Trystero production wrapper isolates both relay participants in child processes', async () => {
  const children = []
  const forkImpl = (_path, _args, options) => {
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.connected = true
    child.send = (message) => {
      if (message?.type === 'stop') {
        child.connected = false
        child.exitCode = 0
        queueMicrotask(() => child.emit('exit', 0, null))
      }
    }
    child.kill = (signal) => {
      child.signalCode = signal
      queueMicrotask(() => child.emit('exit', null, signal))
    }
    children.push({ child, role: options.env.CM_TRYSTERO_ROLE })
    queueMicrotask(() => child.emit('message', { type: 'ready' }))
    if (options.env.CM_TRYSTERO_ROLE === 'initiator') {
      setTimeout(() => child.emit('message', { type: 'done', elapsedMs: 12 }), 0)
    }
    return child
  }
  const result = await checkTrystero('wss://relay.example.test', { timeoutMs: 100, forkImpl })
  assert.equal(result.peerExchange, true)
  assert.equal(children.length, 2)
  assert.deepEqual(children.map((item) => item.role), ['responder', 'initiator'])
  assert.ok(children.every((item) => item.child.exitCode === 0))
})
