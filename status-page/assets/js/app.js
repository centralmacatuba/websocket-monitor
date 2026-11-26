const $ = (selector) => document.querySelector(selector) 
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const statusLabels = { operational: 'Operacional', degraded: 'Desempenho degradado', down: 'Indisponível', maintenance: 'Em manutenção', unknown: 'Sem dados recentes' }
const number = (value) => value == null ? '—' : new Intl.NumberFormat('pt-BR').format(value)
const percent = (value) => value == null ? 'Coletando dados' : `${value.toFixed(3).replace('.', ',')}%`
const dateTime = (value) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC' : '—'

function renderOverall(status, services) {
  const order = ['down', 'degraded', 'unknown', 'maintenance', 'operational']
  const overall = order.find((candidate) => services.some((service) => service.status === candidate)) ?? status
  const copy = {
    operational: ['Todos os sistemas operacionais', 'Os serviços monitorados estão respondendo normalmente.'],
    degraded: ['Desempenho degradado', 'Um ou mais serviços estão respondendo, mas com latência elevada.'],
    down: ['Interrupção em andamento', 'Um ou mais serviços não passaram na verificação de protocolo.'],
    maintenance: ['Manutenção em andamento', 'Há serviços em uma janela de manutenção programada.'],
    unknown: ['Status parcialmente desconhecido', 'Ainda não há amostras recentes suficientes para todos os serviços.'],
  }[overall]
  $('#overall').innerHTML = `<span class="status-dot ${overall}"></span><div><strong>${copy[0]}</strong><p>${copy[1]}</p></div>`
}

function renderServices(services) {
  $('#service-count').textContent = `${services.length} serviços`
  $('#services').innerHTML = services.map((service) => {
    const metrics = service.uptime ?? {}
    const values = ['24h', '7d', '30d'].map((key) => `<div class="metric"><strong>${percent(metrics[key]?.uptime)}</strong><span>Uptime ${key} · ${metrics[key]?.checks ?? 0} checks</span></div>`).join('')
    const latency = service.latencyMs == null ? '—' : `${number(service.latencyMs)} ms`
    return `<article class="service-card"><div class="service-top"><span class="service-name"> ${escapeHtml(service.name)}</span><span class="status-pill ${service.status}">${statusLabels[service.status] ?? statusLabels.unknown}</span></div><div class="service-metrics">${values}</div><div class="service-foot"><span>Latência atual: ${latency}</span><span>${service.uptime?.['24h']?.checks ?? 0} verificações / 24h</span></div><div class="service-foot"><span>Última verificação</span><span>${dateTime(service.lastCheckedAt)}</span></div></article>`
  }).join('')
}

function lineChart(service, samples) {
  const values = samples.filter((sample) => sample[0] >= Date.now() - 24 * 3600_000 && sample[1] === 1 && Number.isFinite(sample[2]))
  const width = 520, height = 135, left = 34, right = 8, top = 10, bottom = 22
  const max = Math.max(100, ...values.map((sample) => sample[2])) * 1.15
  const x = (timestamp) => left + ((timestamp - (Date.now() - 24 * 3600_000)) / (24 * 3600_000)) * (width - left - right)
  const y = (latency) => top + (1 - latency / max) * (height - top - bottom)
  const points = values.map((sample) => [x(sample[0]), y(sample[2])])
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ')
  const last = values.at(-1)
  return `<article class="chart-card"><h3>${escapeHtml(service.name)}</h3><p>${values.length} medições · média ${service.latency24h?.averageMs == null ? '—' : number(service.latency24h.averageMs) + ' ms'} · P95 ${service.latency24h?.p95Ms == null ? '—' : number(service.latency24h.p95Ms) + ' ms'}</p><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Histórico de latência de ${escapeHtml(service.name)} nas últimas 24 horas"><line class="gridline" x1="${left}" y1="${top}" x2="${width-right}" y2="${top}"/><line class="gridline" x1="${left}" y1="${(height+top-bottom)/2}" x2="${width-right}" y2="${(height+top-bottom)/2}"/><line class="gridline" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"/><text class="axis-label" x="0" y="${top+3}">${number(Math.round(max))}</text><text class="axis-label" x="0" y="${height-bottom+3}">0 ms</text><path class="line" d="${path}"/><text class="axis-label" x="${left}" y="${height-4}">-24h</text><text class="axis-label" x="${width-right}" y="${height-4}" text-anchor="end">agora</text></svg></article>`
}

function renderLatency(services, history) {
  $('#latency-charts').innerHTML = services.map((service) => lineChart(service, history.services?.[service.id] ?? [])).join('')
}

function renderUptime(services, history) {
  $('#uptime-history').innerHTML = services.map((service) => {
    const samples = history.services?.[service.id] ?? []
    const days = Array.from({ length: 30 }, (_, index) => {
      const todayUtc = new Date()
      const start = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate()) - (29 - index) * 86400_000
      const end = start + 86400_000
      const maintenance = (history.maintenances ?? []).filter((item) => (item.service === service.id || item.service === 'all') && item.excludeFromUptime !== false)
      const day = samples.filter((sample) => sample[0] >= start && sample[0] < end && !maintenance.some((item) => sample[0] >= Date.parse(item.startsAt) && sample[0] <= Date.parse(item.endsAt)))
      const up = day.filter((sample) => sample[1] === 1).length
      const down = day.filter((sample) => sample[1] === 0).length
      const total = up + down
      const cls = !total ? 'empty' : down === 0 ? 'good' : up === 0 ? 'bad' : 'partial'
      return `<span class="uptime-bar ${cls}" title="${new Date(start).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}: ${total ? ((up/total)*100).toFixed(2)+'% ('+total+' verificações)' : 'sem dados'}"></span>`
    }).join('')
    return `<article class="history-card"><div class="history-head"><strong>${escapeHtml(service.name)}</strong><span class="uptime-value">${percent(service.uptime?.['30d']?.uptime)}</span></div><div class="uptime-bars" role="img" aria-label="Disponibilidade diária de ${escapeHtml(service.name)} nos últimos 30 dias">${days}</div><div class="history-legend"><span><i class="legend-dot" style="background:#238636"></i>100% das verificações OK</span><span><i class="legend-dot" style="background:#d29922"></i>Falhas registradas</span><span><i class="legend-dot" style="background:#343c46"></i>Sem amostras</span></div></article>`
  }).join('')
}

function renderMaintenances(items) {
  const now = Date.now()
  const visible = items.filter((item) => item.status !== 'completed' && Date.parse(item.endsAt) >= now).sort((a,b) => Date.parse(a.startsAt)-Date.parse(b.startsAt))
  $('#maintenances').innerHTML = visible.length ? visible.map((item) => `<article class="notice-card"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description ?? '')}</p><p> ${escapeHtml(item.service === 'all' ? 'Todos os serviços' : item.service)} · ${dateTime(item.startsAt)} – ${dateTime(item.endsAt)}</p></div><span class="status-pill maintenance">${Date.parse(item.startsAt) <= now ? 'Em andamento' : 'Programada'}</span></article>`).join('') : '<p class="empty">Nenhuma manutenção programada publicada.</p>'
}

function renderIncidents(incidents) {
  $('#incident-count').textContent = `${incidents.length} registros`
  $('#incidents').innerHTML = incidents.length ? incidents.slice(0, 30).map((item) => `<article class="incident-card"><div><strong><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></strong><p>${escapeHtml(item.serviceName ?? 'Serviço')} · Início: ${dateTime(item.startedAt)} · ${item.duration ?? 'Duração em andamento'}</p></div><span class="incident-state ${item.state === 'closed' ? 'resolved' : ''}">${item.state === 'closed' ? 'RESOLVIDO' : 'EM ANDAMENTO'}</span></article>`).join('') : '<p class="empty">Nenhum incidente registrado no histórico.</p>'
}

function renderBadges(badges) {
  $('#badges').innerHTML = badges.map((badge) => {
    const url = new URL(badge.path, document.baseURI).href
    const markdown = `![${badge.label}](${url})`
    return `<div class="badge-item"><img src="${badge.path}" alt="${badge.label}"><code>${markdown}</code></div>`
  }).join('')
}

async function load() {
  $('#refresh').disabled = true
  try {
    const [status, history, incidents, maintenance] = await Promise.all(['status.json','history.json','incidents.json','../maintenance.json'].map(async (file) => {
      const url = file === '../maintenance.json' ? new URL('../../maintenance.json', import.meta.url) : new URL(`../../data/${file}`, import.meta.url)
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }))
    renderOverall(status.overallStatus, status.services)
    renderServices(status.services)
    renderLatency(status.services, history)
    renderUptime(status.services, history)
    renderMaintenances(maintenance.maintenances ?? [])
    renderIncidents(incidents.incidents ?? [])
    renderBadges(status.badges ?? [])
    $('#updated-at').textContent = dateTime(status.generatedAt)
  } catch {
    $('#overall').innerHTML = '<span class="status-dot down"></span><div><strong>Não foi possível carregar o status</strong><p>Tente atualizar a página em instantes.</p></div>'
  } finally {
    $('#refresh').disabled = false
  }
}

$('#refresh').addEventListener('click', load)
load()
setInterval(load, 60_000)
