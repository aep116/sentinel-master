import { fileURLToPath } from 'url'
import pLimit from 'p-limit'
import { sendTelegram, buildDownAlert, buildRecoveryAlert, buildSpikeAlert, buildDegradationAlert } from './scripts/telegram.js'
import { sendEmailAlert } from './scripts/email.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SRK = process.env.SUPABASE_SRK
const RUN_TIER3 = process.env.RUN_TIER3 === 'true'
// When CF Workers are live (DRY_RUN=false), GA skips Tier 1 — CF owns that interval
const CF_LIVE = process.env.CLOUDFLARE_DRY_RUN === 'false'
// P0-12: which probe origin this run came from. Overridable so a second runner region
// can stamp its own label, enabling cross-region quorum and per-region liveness.
const MONITOR_REGION = process.env.MONITOR_REGION || 'github-actions'

// >=20% down = a notable broad event: send a heads-up banner but STILL alert per-company.
// A real cloud-region/CDN outage lives in the 20-80% band and must not be silenced.
const SPIKE_THRESHOLD = 0.20
// >=80% down = almost everything is unreachable from our probe = our own monitoring
// infrastructure, not a real internet-wide outage. Suppress the per-company alert storm.
const INFRA_SUPPRESS_THRESHOLD = 0.80

export function detectSpike(results, threshold = SPIKE_THRESHOLD) {
  if (results.length === 0) return false
  const downCount = results.filter((r) => r.status === 'down').length
  return downCount / results.length >= threshold
}

// Classify a run by the down ratio: 'infra' (>=80% — suppress the per-company storm),
// 'spike' (>=20% — banner but still alert per-company), or 'normal'.
export function classifyRun(downRatio) {
  if (downRatio >= INFRA_SUPPRESS_THRESHOLD) return 'infra'
  if (downRatio >= SPIKE_THRESHOLD) return 'spike'
  return 'normal'
}

// Re-alert on a still-open incident at most once per this interval (escalation cadence).
export const INCIDENT_REALERT_COOLDOWN_MS = 60 * 60 * 1000

// Decide an incident action for one company this run. Dedup is the point: while an
// incident is open, repeated down checks do NOT re-alert (except an hourly escalation),
// and a recovery resolves exactly one open incident. This kills the down/recovery
// alert-pair storm a flapping site produced under the old consecutive-counter logic.
// @param {{down: boolean, up: boolean, openIncident: ({last_alert_at?: string}|null|undefined), now: number, cooldownMs?: number}} args
// @returns {'open'|'realert'|'resolve'|'none'}
export function decideIncidentAction({ down, up, openIncident, now, cooldownMs = INCIDENT_REALERT_COOLDOWN_MS }) {
  if (down && !openIncident) return 'open'
  if (down && openIncident) {
    const last = openIncident.last_alert_at ? new Date(openIncident.last_alert_at).getTime() : 0
    return now - last >= cooldownMs ? 'realert' : 'none'
  }
  if (up && openIncident) return 'resolve'
  return 'none'
}

// Default "healthy" status codes (mirror of the Tier 1 worker's DEFAULT_OK_CODES).
// 2xx success + 3xx redirect. Anything else — including 4xx (401 auth wall, 403
// WAF/bot-block, 404, 429 throttle) and 5xx — is DOWN. A genuinely-down site that
// returns a 4xx (crashed app routing to 404, WAF blocking everyone) is now caught.
// Sites that legitimately return a 4xx whitelist it via companies.expected_codes.
export const OK_CODES = new Set([200, 201, 202, 203, 204, 206, 301, 302, 303, 304, 307, 308])

export function isStatusDown(status, expectedCodes) {
  if (Array.isArray(expectedCodes) && expectedCodes.length > 0) {
    return !expectedCodes.includes(status)
  }
  return !OK_CODES.has(status)
}

// Append a unique query param so a CDN/proxy can't serve a stale cached 200 over a
// dead origin. Preserves any existing query string.
export function cacheBust(target) {
  try {
    const u = new URL(target)
    u.searchParams.set('_st', Date.now().toString())
    return u.toString()
  } catch {
    return target
  }
}

// Response time is "degraded" when it exceeds the EMA baseline by this factor (200%).
// Suppressed until a monitor has WARMUP_CHECKS of history to avoid noise on new monitors.
export const DEGRADATION_FACTOR = 2
export const WARMUP_CHECKS = 20

export function isDegraded(responseMs, baselineMs, checksCount, factor = DEGRADATION_FACTOR) {
  if (baselineMs == null || checksCount == null || checksCount <= WARMUP_CHECKS) return false
  return responseMs > baselineMs * factor
}

export function emaUpdate(baselineMs, responseMs) {
  return baselineMs == null ? responseMs : Math.round(baselineMs * 0.98 + responseMs * 0.02)
}

// One RPC call updates avg_response_ms / checks_count / degraded for every up company
// (avoids 500+ per-row PATCHes inside the 4-minute GitHub Actions budget).
async function bulkUpdateStats(updates) {
  if (updates.length === 0) return
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bulk_update_company_stats`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SRK,
      Authorization: `Bearer ${SUPABASE_SRK}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ updates }),
  })
  if (!resp.ok) {
    console.warn(`bulk stats update failed: ${resp.status} ${await resp.text()}`)
  }
}

const INCIDENT_HEADERS = () => ({
  apikey: SUPABASE_SRK,
  Authorization: `Bearer ${SUPABASE_SRK}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
})

async function loadOpenIncidents() {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/incidents?resolved_at=is.null&select=id,company_id,started_at,last_alert_at`,
    { headers: { apikey: SUPABASE_SRK, Authorization: `Bearer ${SUPABASE_SRK}` } }
  )
  if (!resp.ok) {
    console.warn(`Failed to load open incidents: ${resp.status}`)
    return {}
  }
  const rows = await resp.json()
  return Object.fromEntries(rows.map((r) => [r.company_id, r]))
}

async function openIncident(companyId, nowISO) {
  return fetch(`${SUPABASE_URL}/rest/v1/incidents`, {
    method: 'POST',
    headers: INCIDENT_HEADERS(),
    body: JSON.stringify({ company_id: companyId, started_at: nowISO, last_alert_at: nowISO }),
  }).catch((e) => console.warn(`openIncident failed: ${e.message}`))
}

async function resolveIncident(id, durationMin, nowISO) {
  return fetch(`${SUPABASE_URL}/rest/v1/incidents?id=eq.${id}`, {
    method: 'PATCH',
    headers: INCIDENT_HEADERS(),
    body: JSON.stringify({ resolved_at: nowISO, duration_min: durationMin }),
  }).catch((e) => console.warn(`resolveIncident failed: ${e.message}`))
}

async function touchIncident(id, nowISO) {
  return fetch(`${SUPABASE_URL}/rest/v1/incidents?id=eq.${id}`, {
    method: 'PATCH',
    headers: INCIDENT_HEADERS(),
    body: JSON.stringify({ last_alert_at: nowISO }),
  }).catch((e) => console.warn(`touchIncident failed: ${e.message}`))
}

// P0-12: stamp this run's liveness. An external watchdog polls /api/health and pages if
// last_run_at goes stale — catching a deleted/disabled cron, which GitHub won't alert on.
async function writeHeartbeat(source) {
  return fetch(`${SUPABASE_URL}/rest/v1/monitor_heartbeat?on_conflict=source`, {
    method: 'POST',
    headers: { ...INCIDENT_HEADERS(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ source, last_run_at: new Date().toISOString() }),
  }).catch((e) => console.warn(`heartbeat failed: ${e.message}`))
}

async function loadCompanies() {
  // Include tier 1 in GitHub Actions run (Cloudflare Worker is DRY_RUN during setup phase)
  const baseTiers = CF_LIVE ? [2] : [1, 2]
  const tiers = RUN_TIER3 ? [...baseTiers, 3] : baseTiers
  const tierFilter = `tier=in.(${tiers.join(',')})`
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?${tierFilter}&active=eq.true&select=id,name,url,tier,consecutive_failures,expected_codes,avg_response_ms,checks_count,degraded,response_keyword,response_forbidden_keyword`,
    {
      headers: {
        apikey: SUPABASE_SRK,
        Authorization: `Bearer ${SUPABASE_SRK}`,
      },
    }
  )
  if (!resp.ok) throw new Error(`Failed to load companies: ${resp.status}`)
  return resp.json()
}

export async function pingUrl(company) {
  const startTime = Date.now()
  try {
    const resp = await fetch(cacheBust(company.url), {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Sentinel/1.0; +https://sentinel.watch)',
        'cache-control': 'no-cache, no-store, max-age=0',
        'pragma': 'no-cache',
      },
    })
    const responseMs = Date.now() - startTime
    // 2xx/3xx = up; 4xx + 5xx = down (per-company expected_codes can whitelist a 4xx).
    let isDown = isStatusDown(resp.status, company.expected_codes)
    let statusDesc = `HTTP ${resp.status}`
    // Body validation: a 200 serving a maintenance/login/error page is still down.
    if (!isDown && (company.response_keyword || company.response_forbidden_keyword)) {
      const body = await resp.text()
      if (company.response_keyword && !body.includes(company.response_keyword)) {
        isDown = true
        statusDesc = `HTTP ${resp.status} — missing keyword "${company.response_keyword}"`
      } else if (company.response_forbidden_keyword && body.includes(company.response_forbidden_keyword)) {
        isDown = true
        statusDesc = `HTTP ${resp.status} — forbidden keyword "${company.response_forbidden_keyword}"`
      }
    }
    return {
      company_id: company.id,
      monitor_id: null,
      status: isDown ? 'down' : 'up',
      response_ms: responseMs,
      http_status: resp.status,
      region: MONITOR_REGION,
      statusDesc,
    }
  } catch (e) {
    const responseMs = Date.now() - startTime
    const isTimeout = e.name === 'TimeoutError' || responseMs >= 9900
    return {
      company_id: company.id,
      monitor_id: null,
      status: 'down',
      response_ms: responseMs,
      http_status: null,
      region: MONITOR_REGION,
      statusDesc: isTimeout ? 'Timeout after 10s' : `Connection error: ${e.message}`,
    }
  }
}

async function batchWrite(results) {
  // Strip internal fields before writing
  const rows = results.map(({ statusDesc, ...r }) => r)
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/monitoring_results`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SRK,
      Authorization: `Bearer ${SUPABASE_SRK}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Supabase write failed ${resp.status}: ${text}`)
  }
}

async function updateConsecutiveFailures(companyId, count) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?id=eq.${encodeURIComponent(companyId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SRK,
        Authorization: `Bearer ${SUPABASE_SRK}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ consecutive_failures: count }),
    }
  )
  if (!resp.ok) {
    console.warn(`Failed to update consecutive_failures for ${companyId}: ${resp.status}`)
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SRK) {
    console.error('Missing SUPABASE_URL or SUPABASE_SRK env vars')
    process.exit(1)
  }
  console.log(`Starting monitoring run. CF_LIVE=${CF_LIVE}, RUN_TIER3=${RUN_TIER3}`)

  const companies = await loadCompanies()
  console.log(`Loaded ${companies.length} companies`)

  if (companies.length === 0) {
    console.log('No companies to monitor')
    return
  }

  // Build lookup map for company metadata (name, url, consecutive_failures)
  const companyMap = Object.fromEntries(companies.map((c) => [c.id, c]))

  const limit = pLimit(50)
  const results = await Promise.all(
    companies.map((company) => limit(() => pingUrl(company)))
  )

  const upCount = results.filter((r) => r.status === 'up').length
  const downCount = results.filter((r) => r.status === 'down').length
  console.log(`Results: ${upCount} up, ${downCount} down`)

  const downRatio = results.length ? downCount / results.length : 0
  const pct = Math.round(downRatio * 100)

  // P0-7: persist data BEFORE alerting. Telegram/email can't be unsent; if the write
  // failed after we paged, the dashboard would show no incident. Write first.
  await batchWrite(results)
  console.log(`Wrote ${results.length} results to Supabase`)
  await writeHeartbeat(MONITOR_REGION) // P0-12: liveness, recorded on every run

  // P0-6: only a near-total failure (>=80%) is treated as our own infrastructure and
  // suppresses the per-company storm. A 20-80% band is a genuine broad outage —
  // send a banner AND still fire per-company alerts below.
  const runClass = classifyRun(downRatio)
  if (runClass === 'infra') {
    console.warn(`[INFRA] ${downCount}/${results.length} (${pct}%) down — likely monitoring infra, suppressing per-company alerts`)
    await sendTelegram(buildSpikeAlert(downCount, results.length, true))
    return
  }
  if (runClass === 'spike') {
    console.warn(`[SPIKE] ${downCount}/${results.length} (${pct}%) down — broad outage, banner + per-company alerts`)
    await sendTelegram(buildSpikeAlert(downCount, results.length, false))
  }

  // Process alerts and update consecutive_failures
  const updateLimit = pLimit(10)
  const alertPromises = []
  const statsUpdates = []
  const openIncidents = await loadOpenIncidents()
  const now = Date.now()
  const nowISO = new Date(now).toISOString()

  for (const result of results) {
    const company = companyMap[result.company_id]
    if (!company) continue

    const prevFailures = company.consecutive_failures ?? 0
    const newFailures = result.status === 'down' ? prevFailures + 1 : 0

    // Only update DB if the count changed
    if (newFailures !== prevFailures) {
      alertPromises.push(
        updateLimit(() => updateConsecutiveFailures(result.company_id, newFailures))
      )
    }

    // Incident lifecycle (P0-8): dedup alerts and track open -> resolved. A sustained
    // outage opens ONE incident (one down alert); flapping no longer re-fires down/recovery
    // pairs; a still-open incident only re-alerts hourly (escalation).
    const openInc = openIncidents[result.company_id]
    const down = result.status === 'down' && newFailures >= 3
    const up = result.status === 'up'
    const action = decideIncidentAction({ down, up, openIncident: openInc, now, cooldownMs: INCIDENT_REALERT_COOLDOWN_MS })

    if (action === 'open') {
      console.log(`[INCIDENT-OPEN] ${company.name} (${newFailures} consecutive failures)`)
      alertPromises.push(updateLimit(() => openIncident(result.company_id, nowISO)))
      alertPromises.push(sendTelegram(buildDownAlert(company, newFailures, result.statusDesc)))
      alertPromises.push(sendEmailAlert({ type: 'outage', company_or_site: company.name, url: company.url }))
    } else if (action === 'realert') {
      console.log(`[INCIDENT-ESCALATE] ${company.name} still down`)
      alertPromises.push(updateLimit(() => touchIncident(openInc.id, nowISO)))
      alertPromises.push(sendTelegram(buildDownAlert(company, newFailures, result.statusDesc)))
      alertPromises.push(sendEmailAlert({ type: 'outage', company_or_site: company.name, url: company.url }))
    } else if (action === 'resolve') {
      const durationMin = openInc.started_at
        ? Math.max(1, Math.round((now - new Date(openInc.started_at).getTime()) / 60000))
        : 0
      console.log(`[INCIDENT-RESOLVE] ${company.name} after ~${durationMin}min`)
      alertPromises.push(updateLimit(() => resolveIncident(openInc.id, durationMin, nowISO)))
      alertPromises.push(sendTelegram(buildRecoveryAlert(company, durationMin, result.response_ms)))
      alertPromises.push(sendEmailAlert({ type: 'recovery', company_or_site: company.name, url: company.url, duration_min: durationMin }))
    }

    // EMA baseline maintenance + response-time degradation (up results only)
    if (result.status === 'up') {
      const baseline = company.avg_response_ms ?? null
      const checks = company.checks_count ?? 0
      let degraded = company.degraded ?? false
      if (isDegraded(result.response_ms, baseline, checks) && !degraded) {
        const pctAbove = Math.round((result.response_ms / baseline - 1) * 100)
        console.log(`[DEGRADED] ${company.name} ${result.response_ms}ms vs ${baseline}ms (${pctAbove}% above)`)
        alertPromises.push(sendTelegram(buildDegradationAlert(company, result.response_ms, baseline, pctAbove)))
        alertPromises.push(
          sendEmailAlert({ type: 'degradation', company_or_site: company.name, url: company.url, response_ms: result.response_ms, baseline_ms: baseline, pct_above: pctAbove })
        )
        degraded = true
      } else if (degraded && baseline != null && result.response_ms < baseline * 1.5) {
        degraded = false // hysteresis: clear once back near baseline
      }
      statsUpdates.push({
        id: result.company_id,
        avg_response_ms: emaUpdate(baseline, result.response_ms),
        checks_count: checks + 1,
        degraded,
      })
    }
  }

  await Promise.all(alertPromises)
  await bulkUpdateStats(statsUpdates)
}

const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
  main().catch((e) => {
    console.error('Monitor run failed:', e)
    process.exit(1)
  })
}
