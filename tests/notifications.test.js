import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { dispatchNotifications } from '../src/notifications.js'

const event = {
  type: 'incident.opened',
  service: 'eaglercraft-wisp',
  serviceName: 'EaglerCraft Wisp v2',
  timestamp: '2026-11-27T23:00:00.000Z',
  attempts: 8,
  failureCode: 'negotiation_timeout',
  incidentUrl: 'https://github.com/centralmacatuba/websocket-monitor/issues/99',
}

test('dispatches incident notifications to Discord, Telegram and signed custom webhook', async () => {
  const requests = []
  const env = {
    WS_NOTIFY_DISCORD_ENABLED: 'true',
    WS_NOTIFY_DISCORD_WEBHOOK_URL: 'https://discord.example.test/webhook',
    WS_NOTIFY_TELEGRAM_ENABLED: 'true',
    WS_NOTIFY_TELEGRAM_BOT_TOKEN: 'test-bot-token',
    WS_NOTIFY_TELEGRAM_CHAT_ID: '-100123',
    WS_NOTIFY_WEBHOOK_ENABLED: 'true',
    WS_NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/monitor',
    WS_NOTIFY_WEBHOOK_SECRET: 'test-signing-secret',
  }
  const result = await dispatchNotifications(event, env, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200 }
    },
  })
  assert.equal(result.attempted, 3)
  assert.ok(result.results.every((item) => item.ok))
  assert.equal(requests.length, 3)

  const discord = requests.find((item) => item.url.includes('discord'))
  assert.deepEqual(JSON.parse(discord.options.body).allowed_mentions, { parse: [] })
  assert.match(JSON.parse(discord.options.body).content, /negotiation_timeout/)

  const telegram = requests.find((item) => item.url.includes('telegram'))
  assert.equal(JSON.parse(telegram.options.body).chat_id, '-100123')

  const webhook = requests.find((item) => item.url.includes('hooks'))
  const expected = createHmac('sha256', env.WS_NOTIFY_WEBHOOK_SECRET).update(webhook.options.body).digest('hex')
  assert.equal(webhook.options.headers['X-CM-Webhook-Signature'], `sha256=${expected}`)
  assert.equal(JSON.parse(webhook.options.body).schema, 'centralmacatuba.websocket-monitor.v1')
})

test('a failing notification destination does not block the other destinations', async () => {
  const result = await dispatchNotifications(event, {
    WS_NOTIFY_DISCORD_ENABLED: 'true',
    WS_NOTIFY_DISCORD_WEBHOOK_URL: 'https://discord.example.test/webhook',
    WS_NOTIFY_TELEGRAM_ENABLED: 'true',
    WS_NOTIFY_TELEGRAM_BOT_TOKEN: 'test',
    WS_NOTIFY_TELEGRAM_CHAT_ID: '123',
  }, {
    fetchImpl: async (url) => ({ ok: !url.includes('discord'), status: url.includes('discord') ? 500 : 200 }),
  })
  assert.deepEqual(result.results, [
    { destination: 'discord', ok: false },
    { destination: 'telegram', ok: true },
  ])
})

test('does not send notifications when all destinations are disabled', async () => {
  let calls = 0
  const result = await dispatchNotifications(event, {
    WS_NOTIFY_DISCORD_ENABLED: 'false',
    WS_NOTIFY_TELEGRAM_ENABLED: 'false',
    WS_NOTIFY_WEBHOOK_ENABLED: 'false',
  }, { fetchImpl: async () => { calls += 1; return { ok: true } } })
  assert.deepEqual(result, { attempted: 0, results: [] })
  assert.equal(calls, 0)
})

test('rejects insecure custom webhook URLs without exposing credentials', async () => {
  const result = await dispatchNotifications(event, {
    WS_NOTIFY_WEBHOOK_ENABLED: 'true',
    WS_NOTIFY_WEBHOOK_URL: 'http://hooks.example.test/monitor',
  }, { fetchImpl: async () => { throw new Error('must not be called') } })
  assert.deepEqual(result.results, [{ destination: 'webhook', ok: false }])
})
