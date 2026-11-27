export function applyServiceFreshness(service, now = Date.now()) {
  const lastCheckedAt = Date.parse(service.lastCheckedAt)
  const staleAfterMs = Number(service.staleAfterMs)
  const maintenanceEndsAt = Date.parse(service.maintenance?.endsAt)
  const maintenanceEnded = service.status === 'maintenance'
    && Number.isFinite(maintenanceEndsAt)
    && maintenanceEndsAt <= now
  const stale = service.status !== 'maintenance'
    && (!Number.isFinite(lastCheckedAt) || !Number.isFinite(staleAfterMs) || now - lastCheckedAt > staleAfterMs)
  return maintenanceEnded || stale
    ? { ...service, status: 'unknown', statusReason: 'stale-data' }
    : service
}
