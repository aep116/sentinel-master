import pLimit from 'p-limit'
import { sendTelegram, buildDownAlert, buildRecoveryAlert } from './scripts/telegram.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SRK = process.env.SUPABASE_SRK
const RUN_TIER3 = process.env.RUN_TIER3 === 'true'

if (!SUPABASE_URL || !SUPABASE_SRK) {
  console.error('Missing SUPABASE_URL or SUPABASE_SRK env vars')
  process.exit(1)
}

async function loadCompanies() {
  // Include tier 1 in GitHub Actions run (Cloudflare Worker is DRY_RUN during setup phase)
  const tiers = RUN_TIER3 ? [1, 2, 3] : [1, 2]
  const tierFilter = `tier=in.(${tiers.join(',')})`
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?${tierFilter}&active=eq.true&select=id,name,url,tier,consecutive_failures`,
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

async function pingUrl(company) {
  const startTime = Date.now()
  try {
    const resp = await fetch(company.url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': 'Sentinel/1.0 (+https://sentinel.watch)' },
    })
    const responseMs = Date.now() - startTime
    return {
      company_id: company.id,
      monitor_id: null,
      status: resp.ok ? 'up' : 'down',
      response_ms: responseMs,
      http_status: resp.status,
      region: 'github-actions',
      statusDesc: resp.ok ? `HTTP ${resp.status}` : `HTTP ${resp.status} error`,
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
      region: 'github-actions',
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
  console.log(`Starting monitoring run. Tiers: ${RUN_TIER3 ? '1,2,3' : '1,2'}`)

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

  // Process alerts and update consecutive_failures
  const updateLimit = pLimit(10)
  const alertPromises = []

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

    // DOWN alert: exactly at threshold (not every subsequent failure)
    if (result.status === 'down' && newFailures === 3) {
      console.log(`[ALERT] ${company.name} hit 3 consecutive failures — sending down alert`)
      alertPromises.push(
        sendTelegram(buildDownAlert(company, newFailures, result.statusDesc))
      )
    }

    // RECOVERY alert: was down (>=3 consecutive), now up
    if (result.status === 'up' && prevFailures >= 3) {
      const durationMin = Math.round((prevFailures * 5)) // approximate: 5-min checks
      console.log(`[RECOVERY] ${company.name} recovered after ~${durationMin}min`)
      alertPromises.push(
        sendTelegram(buildRecoveryAlert(company, durationMin, result.response_ms))
      )
    }
  }

  await Promise.all(alertPromises)

  await batchWrite(results)
  console.log(`Wrote ${results.length} results to Supabase`)
}

main().catch((e) => {
  console.error('Monitor run failed:', e)
  process.exit(1)
})
