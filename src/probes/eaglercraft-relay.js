import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'

const PROTOCOL_VERSION = 1
const PACKET_HANDSHAKE = 0x00
const PACKET_PONG = 0x69
const CONNECTION_TYPE_PING = 0x03

export function createEaglerPingPacket() {
  return Buffer.from([PACKET_HANDSHAKE, PROTOCOL_VERSION, CONNECTION_TYPE_PING])
}

function readJavaUtf(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('Truncated EaglerSPRelay pong')
  const length = buffer.readUInt16BE(offset)
  const start = offset + 2
  const end = start + length
  if (end > buffer.length) throw new Error('Truncated EaglerSPRelay pong string')
  return { value: buffer.toString('utf8', start, end), offset: end }
}

/** Parse the EaglerSPRelay PKT 0x69 pong: packet id, protocol version, comment and brand. */
export function parseEaglerPong(input) {
  const packet = Buffer.from(input)
  if (packet.length < 2 || packet[0] !== PACKET_PONG) throw new Error('Unexpected EaglerSPRelay response packet')
  const version = packet[1]
  if (version !== PROTOCOL_VERSION) throw new Error('Unsupported EaglerSPRelay protocol version')
  const comment = readJavaUtf(packet, 2)
  const brand = readJavaUtf(packet, comment.offset)
  if (brand.offset !== packet.length) throw new Error('Unexpected trailing EaglerSPRelay pong data')
  return { protocolVersion: version, comment: comment.value, brand: brand.value }
}

export function checkEaglerRelay(url, { timeoutMs = 15_000, WebSocketClass = WebSocket } = {}) {
  const normalized = new URL(url)
  if (!['ws:', 'wss:'].includes(normalized.protocol)) throw new Error('Invalid EaglerSPRelay WebSocket URL')

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const socket = new WebSocketClass(normalized.toString(), {
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: timeoutMs,
    })
    let settled = false
    const timer = setTimeout(() => fail(new Error('EaglerSPRelay protocol timeout')), timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        try { socket.terminate() } catch {}
        reject(error)
      } else {
        try { socket.close(1000, 'Monitor probe complete') } catch { socket.terminate() }
        resolve({ transport: true, protocol: true, protocolVersion: value.protocolVersion, elapsedMs: Date.now() - startedAt })
      }
    }
    const fail = (error) => finish(error)

    socket.once('open', () => {
      try { socket.send(createEaglerPingPacket()) } catch { fail(new Error('EaglerSPRelay ping could not be sent')) }
    })
    socket.once('message', (data, isBinary) => {
      if (!isBinary) return fail(new Error('EaglerSPRelay returned a text frame'))
      try { finish(null, parseEaglerPong(data)) } catch (error) { fail(error) }
    })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      fail(new Error(`EaglerSPRelay handshake rejected: HTTP ${response.statusCode ?? 'unknown'}`))
    })
    socket.once('error', () => fail(new Error('EaglerSPRelay WebSocket connection failed')))
    socket.once('close', () => {
      if (!settled) fail(new Error('EaglerSPRelay closed before protocol response'))
    })
  })
}
