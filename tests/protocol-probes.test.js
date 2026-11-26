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

function javaUtf(value) {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, bytes])
}

test('builds the EaglerSPRelay v1 ping handshake packet', () => {
  assert.deepEqual(createEaglerPingPacket(), Buffer.from([0x00, 0x01, 0x03]))
})

test('parses the EaglerSPRelay pong packet and metadata', () => {
  const packet = Buffer.concat([Buffer.from([0x69, 0x01]), javaUtf('status'), javaUtf('relay-brand')])
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
      assert.deepEqual(Buffer.from(packet), Buffer.from([0x00, 0x01, 0x03]))
      const comment = javaUtf('local test relay')
      const brand = javaUtf('EaglerSPRelay')
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
  const room = {
    getSelf: async () => ['self'],
    makeAction: () => ({
      onMessage: (callback) => { actionMessage = callback },
      send: async (message) => actionMessage?.({ kind: 'ack', nonce: validAck ? message.nonce : 'wrong-nonce' }),
    }),
    onUserJoin: (callback) => { if (peerJoins) queueMicrotask(() => callback('remote-peer')) },
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
