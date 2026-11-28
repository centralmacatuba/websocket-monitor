import { checkPeerJsInProcess } from './peerjs.js'

process.once('message', async (message) => {
  if (message?.type !== 'probe' || typeof message.url !== 'string') process.exit(2)
  try {
    const result = await checkPeerJsInProcess(message.url, { timeoutMs: message.timeoutMs })
    if (process.connected) process.send({ type: 'result', result }, () => process.exit(0))
    else process.exit(0)
  } catch (error) {
    if (process.connected) process.send({ type: 'error', error: error instanceof Error ? error.message : 'PeerJS probe failed' }, () => process.exit(1))
    else process.exit(1)
  }
})
