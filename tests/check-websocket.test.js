import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { WebSocketServer } from 'ws'
import { checkWebSocket, normalizeWebSocketUrl } from '../src/check-websocket.js'
import { monitorTarget } from '../src/monitor.js'

let server
let websocketServer
let baseUrl

before(async () => {
  server = createServer()
  websocketServer = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  baseUrl = `ws://127.0.0.1:${address.port}/`
})

after(async () => {
  await new Promise((resolve) => websocketServer.close(resolve))
  await new Promise((resolve) => server.close(resolve))
})

test('normalizes valid WebSocket URLs', () => {
  assert.equal(normalizeWebSocketUrl('wss://relay.example.test/'), 'wss://relay.example.test/')
})

test('rejects non-WebSocket protocols', () => {
  assert.throws(
    () => normalizeWebSocketUrl('https://relay.example.test/'),
    /must use ws:\/\/ or wss:\/\//,
  )
})

test('completes the WebSocket handshake and Ping/Pong exchange', async () => {
  const result = await checkWebSocket(baseUrl, {
    connectTimeoutMs: 2_000,
    pongTimeoutMs: 2_000,
  })

  assert.equal(result.ok, true)
  assert.equal(result.handshake, true)
  assert.equal(result.pong, true)
  assert.ok(result.elapsedMs >= 0)
})

test('ignores unsolicited Pong frames that do not match its Ping', async () => {
  const unsolicitedServer = createServer()
  const unsolicitedWebSocketServer = new WebSocketServer({
    noServer: true,
    autoPong: false,
  })

  unsolicitedServer.on('upgrade', (request, socket, head) => {
    unsolicitedWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      unsolicitedWebSocketServer.emit('connection', websocket, request)
    })
  })

  unsolicitedWebSocketServer.on('connection', (websocket) => {
    websocket.pong(Buffer.from('unsolicited-pong'))
  })

  await new Promise((resolve) => unsolicitedServer.listen(0, '127.0.0.1', resolve))
  const address = unsolicitedServer.address()

  try {
    await assert.rejects(
      checkWebSocket(`ws://127.0.0.1:${address.port}/`, {
        connectTimeoutMs: 2_000,
        pongTimeoutMs: 100,
      }),
      /did not answer Ping/,
    )
  } finally {
    await new Promise((resolve) => unsolicitedWebSocketServer.close(resolve))
    await new Promise((resolve) => unsolicitedServer.close(resolve))
  }
})

test('reports a rejected WebSocket handshake with the HTTP status', async () => {
  const httpServer = createServer((_request, response) => {
    response.writeHead(426, { connection: 'close' })
    response.end('WebSocket upgrade required')
  })

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()

  try {
    await assert.rejects(
      checkWebSocket(`ws://127.0.0.1:${address.port}/`, { connectTimeoutMs: 2_000 }),
      /HTTP 426/,
    )
  } finally {
    await new Promise((resolve) => httpServer.close(resolve))
  }
})

test('retries a failed handshake and succeeds when the relay becomes available', async () => {
  const retryServer = createServer()
  const retryWebSocketServer = new WebSocketServer({ noServer: true })
  let upgrades = 0

  retryServer.on('upgrade', (request, socket, head) => {
    upgrades += 1
    if (upgrades === 1) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }

    retryWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      retryWebSocketServer.emit('connection', websocket, request)
    })
  })

  await new Promise((resolve) => retryServer.listen(0, '127.0.0.1', resolve))
  const address = retryServer.address()
  const logs = { info() {}, warn() {}, error() {} }

  try {
    const result = await monitorTarget({
      name: 'test relay',
      url: `ws://127.0.0.1:${address.port}/`,
    }, {
      maxAttempts: 2,
      retryDelayMs: 0,
      connectTimeoutMs: 2_000,
      pongTimeoutMs: 2_000,
      log: logs,
    })

    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
    assert.equal(upgrades, 2)
  } finally {
    await new Promise((resolve) => retryWebSocketServer.close(resolve))
    await new Promise((resolve) => retryServer.close(resolve))
  }
})
