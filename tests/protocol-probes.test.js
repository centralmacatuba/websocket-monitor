import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEaglerPingPacket, parseEaglerPong } from '../src/probes/eaglercraft-relay.js'

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

import { parsePeerServerUrl } from '../src/probes/peerjs.js'
import { checkWisp } from '../src/probes/wisp.js'

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
