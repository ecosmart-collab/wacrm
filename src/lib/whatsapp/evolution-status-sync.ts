export interface EvolutionStatusRow {
  status: 'connected' | 'disconnected'
  connected_at: string | null
  disconnected_at: string | null
}

/**
 * Decide what (if anything) to write to whatsapp_config given the DB's
 * current status columns and a freshly observed `connected` boolean.
 *
 * connected_at / disconnected_at are "since when" markers, not
 * last-checked timestamps — they must only move on an actual state
 * transition (disconnected→connected or connected→disconnected), never
 * on every webhook delivery or every cron tick that just reconfirms the
 * current state. Returns null when there's nothing to write (no
 * transition), so callers can skip the UPDATE entirely.
 *
 * Deliberately does not clear the opposite timestamp on a transition
 * (e.g. reconnecting doesn't null out disconnected_at) — both columns
 * independently mean "last time this happened" and keeping both around
 * gives free diagnostic history.
 */
export function buildEvolutionStatusPatch(
  current: EvolutionStatusRow,
  connected: boolean,
): Record<string, unknown> | null {
  const newStatus: 'connected' | 'disconnected' = connected ? 'connected' : 'disconnected'
  if (newStatus === current.status) return null

  const now = new Date().toISOString()
  return {
    status: newStatus,
    updated_at: now,
    ...(newStatus === 'connected' ? { connected_at: now } : { disconnected_at: now }),
  }
}
