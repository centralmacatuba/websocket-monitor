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
