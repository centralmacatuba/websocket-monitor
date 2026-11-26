import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { checkPeerJs } from '../src/probes/peerjs.js'

const enabled = process.env.RUN_PEERJS_INTEGRATION === '1'

async function getAvailablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForPeerServer(url, process, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`PeerServer exited before becoming ready (code ${process.exitCode}): ${process.output()}`)
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = new Error(`PeerServer health endpoint returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  throw new Error(`PeerServer did not become ready: ${lastError?.message ?? 'startup timeout'}; ${process.output()}`)
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }),
  ])
}

test('PeerJS probe completes a real raw-data round-trip against the official local PeerServer', {
  skip: !enabled && 'Set RUN_PEERJS_INTEGRATION=1 to run the real PeerServer integration test',
  timeout: 120_000,
}, async () => {
  const port = await getAvailablePort()
  const baseUrl = `http://127.0.0.1:${port}/peerjs`
  const child = spawn('pnpm', [
    'dlx',
    'peer@1.0.2',
    'peerjs',
    '--port', String(port),
    '--key', 'peerjs',
    '--path', '/peerjs',
    '--alive_timeout', '15000',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-8_000) })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-8_000) })
  child.output = () => output

  try {
    await waitForPeerServer(baseUrl, child)
    const result = await checkPeerJs(baseUrl, { timeoutMs: 20_000 })

    assert.equal(result.transport, true)
    assert.equal(result.registration, true)
    assert.equal(result.dataChannel, true)
    assert.equal(result.rawExchange, true)
    assert.equal(result.protocol, true)
  } finally {
    await stopProcess(child)
  }
})
