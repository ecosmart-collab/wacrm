import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'
import { getInstanceStatus } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { buildEvolutionStatusPatch } from '@/lib/whatsapp/evolution-status-sync'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

function safeSecretMatch(supplied: string, expected: string): boolean {
  // Trimmed defensively — hosting panels and .env files are prone to
  // adding an invisible trailing newline/space to a pasted secret, which
  // silently breaks the length check below on every request until the
  // stored value itself is fixed. Trimming both sides makes the compare
  // robust to that class of accident.
  const a = Buffer.from(supplied.trim())
  const b = Buffer.from(expected.trim())
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Safety-net reconciliation for Evolution instance connection status.
 *
 * The CONNECTION_UPDATE webhook (see
 * webhook/evolution/[configId]/route.ts) covers the common case in real
 * time, but webhook delivery can be missed (Evolution server restart
 * mid-delivery, transient network issue, an instance whose webhook
 * hasn't been re-registered yet since this feature shipped — see
 * evolution-api.ts's setEvolutionWebhook). This cron polls every
 * Evolution account's live status directly and reconciles
 * whatsapp_config, so a missed webhook is caught on the next run at
 * worst.
 *
 * Auth: reuses AUTOMATION_CRON_SECRET via the same `x-cron-secret`
 * header convention as /api/automations/cron and /api/flows/cron — one
 * secret for operators to provision. Hit on a schedule by an external
 * pinger (Hostinger deploy, no Vercel Cron) — no in-repo scheduler
 * wiring.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (!supplied || !safeSecretMatch(supplied, expected)) {
    // TEMPORARY diagnostic (2026-07-17): debugging a persistent 401 in
    // production despite a confirmed-matching secret. Reports whether
    // the x-cron-secret header even arrived (Hostinger's edge/CDN layer
    // — "Server: hcdn" on responses — may be stripping non-standard
    // headers before they reach the app) and the header name list, with
    // no secret values exposed. Remove once root-caused.
    return NextResponse.json(
      {
        error: 'Unauthorized',
        debug: {
          headerReceived: supplied !== null,
          suppliedLength: supplied?.length ?? null,
          expectedLength: expected.trim().length,
          headerNames: Array.from(request.headers.keys()),
        },
      },
      { status: 401 },
    )
  }

  const admin = supabaseAdmin()
  const { data: rows, error } = await admin
    .from('whatsapp_config')
    .select(
      'id, status, connected_at, disconnected_at, evolution_base_url, evolution_instance_name, evolution_api_key',
    )
    .eq('provider', 'evolution')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) return NextResponse.json({ checked: 0, updated: 0, failed: 0 })

  let updated = 0
  let failed = 0

  // Sequential on purpose — avoids hammering N different self-hosted
  // Evolution servers concurrently from one cron tick, and keeps failure
  // isolation simple (one slow/down server doesn't need Promise.allSettled
  // ceremony).
  for (const row of rows) {
    try {
      const apiKey = decrypt(row.evolution_api_key as string)
      const result = await getInstanceStatus({
        baseUrl: row.evolution_base_url as string,
        apiKey,
        instanceName: row.evolution_instance_name as string,
      })

      const patch = buildEvolutionStatusPatch(
        {
          status: row.status as 'connected' | 'disconnected',
          connected_at: row.connected_at as string | null,
          disconnected_at: row.disconnected_at as string | null,
        },
        result.connected,
      )
      if (!patch) continue // already in sync — nothing to write

      const { error: updateError } = await admin
        .from('whatsapp_config')
        .update(patch)
        .eq('id', row.id)
      if (updateError) {
        console.error(`[evolution-cron] failed to update config ${row.id}:`, updateError)
        failed++
        continue
      }
      updated++
    } catch (err) {
      // One account's decrypt/network failure (bad key, server down,
      // timeout) must not abort the whole sweep — log and move on.
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[evolution-cron] status check failed for config ${row.id}:`, message)
      failed++
    }
  }

  return NextResponse.json({ checked: rows.length, updated, failed })
}
