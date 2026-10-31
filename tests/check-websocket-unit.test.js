import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { checkWebSocket, normalizeWebSocketUrl } from '../src/check-websocket.js'

class FakeSocket extends EventEmitter {
  static instance

  constructor(url, options) {
    super()
    FakeSocket.instance = this
    this.url = url
    this.options = options
    this.terminated = 0
  }

  ping(payload) { this.payload = payload }
  close(code, reason) { this.closedWith = [code, reason] }
  terminate() { this.terminated += 1 }
}

function start(options = {}) {
  const result = checkWebSocket('ws://EXAMPLE.test', { WebSocketClass: FakeSocket, ...options })
  return { result, socket: FakeSocket.instance }
}

test('validates missing, malformed and unsafe URLs without echoing input', () => {
  for (const value of [undefined, null, 1, '', '  ']) {
    assert.throws(() => normalizeWebSocketUrl(value), /URL is missing/)
  }
  for (const value of ['not a URL', 'ws://']) {
    assert.throws(() => normalizeWebSocketUrl(value), /URL is invalid/)
  }
  for (const value of ['ws://user:secret@example.test/', 'ws://example.test/#secret']) {
    assert.throws(() => normalizeWebSocketUrl(value), (error) => {
      assert.match(error.message, /unsupported or unsafe/)
      assert.doesNotMatch(error.message, /secret/)
      return true
    })
  }
  assert.equal(normalizeWebSocketUrl(' WSS://EXAMPLE.test:443/path?q=1 '), 'wss://example.test/path?q=1')
})

test('sends a Ping and accepts only its matching Buffer Pong, then closes normally', async () => {
  const { result, socket } = start({ connectTimeoutMs: 123, closeTimeoutMs: 50 })
  assert.equal(socket.url, 'ws://example.test/')
  assert.deepEqual(socket.options, { handshakeTimeout: 123, perMessageDeflate: false, followRedirects: false })
  socket.emit('open')
  assert.equal(socket.payload.length, 16)
  socket.emit('pong', 'not a buffer')
  const mismatched = Buffer.from(socket.payload)
  mismatched[0] ^= 0xff
  socket.emit('pong', mismatched)
  socket.emit('pong', Buffer.from(socket.payload))
  assert.deepEqual(socket.closedWith, [1000, 'Central Macatuba monitor check'])
  socket.emit('close', 1000, Buffer.alloc(0))
  const value = await result
  assert.equal(value.ok, true)
  assert.equal(value.handshake, true)
  assert.equal(value.pong, true)
  assert.ok(value.elapsedMs >= 0)
  assert.equal(socket.terminated, 0)
})

test('forces termination when the peer does not complete the close handshake', async () => {
  const { result, socket } = start({ closeTimeoutMs: 10 })
  socket.emit('open')
  socket.emit('pong', socket.payload)
  await result
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(socket.terminated, 1)
})

test('reports and terminates a stalled handshake', async () => {
  const { result, socket } = start({ connectTimeoutMs: 1 })
  await assert.rejects(result, /handshake timed out after 1 ms/)
  assert.equal(socket.terminated, 1)
})

test('reports a missing Pong after opening', async () => {
  const { result, socket } = start({ pongTimeoutMs: 10 })
  socket.emit('open')
  await assert.rejects(result, /did not answer Ping within 10 ms/)
  assert.equal(socket.terminated, 1)
})

test('reports errors sending Ping and connection errors', async () => {
  const first = start()
  first.socket.ping = () => { throw new Error('write failed') }
  first.socket.emit('open')
  await assert.rejects(first.result, /Unable to send WebSocket Ping: write failed/)
  assert.equal(first.socket.terminated, 1)

  const second = start()
  second.socket.emit('error', new Error('connection refused'))
  await assert.rejects(second.result, /WebSocket connection failed: connection refused/)
  assert.equal(second.socket.terminated, 1)
})

test('reports premature closes before and after the handshake', async () => {
  for (const opened of [false, true]) {
    const { result, socket } = start()
    if (opened) socket.emit('open')
    socket.emit('close', 1006, Buffer.alloc(0))
    await assert.rejects(result, opened
      ? /closed before Pong \(code 1006: no close reason\)/
      : /closed before handshake completed \(code 1006: no close reason\)/)
    assert.equal(socket.terminated, 1)
  }
})

test('drains an unexpected response and reports an unknown status', async () => {
  const { result, socket } = start()
  let drained = false
  socket.emit('unexpected-response', {}, { resume() { drained = true } })
  await assert.rejects(result, /handshake rejected with HTTP unknown/)
  assert.equal(drained, true)
  assert.equal(socket.terminated, 1)
})

test('still succeeds if closing the socket throws after a matching Pong', async () => {
  const { result, socket } = start()
  socket.close = () => { throw new Error('close failed') }
  socket.emit('open')
  socket.emit('pong', socket.payload)
  assert.equal((await result).ok, true)
  assert.equal(socket.terminated, 1)
  socket.emit('close', 1006, Buffer.alloc(0))
})
