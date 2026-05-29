import pLimit from 'p-limit'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SRK = process.env.SUPABASE_SRK
const RUN_TIER3 = process.env.RUN_TIER3 === 'true'

if (!SUPABASE_URL || !SUPABASE_SRK) {
  console.error('Missing SUPABASE_URL or SUPABASE_SRK env vars')
  process.exit(1)
}

async function loadCompanies() {
  const tiers = RUN_TIER3 ? [2, 3] : [2]
  const tierFilter = `tier=in.(${tiers.join(',')})`
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?${tierFilter}&active=eq.true&select=id,name,url,tier`,
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
    }
  } catch (e) {
    return {
      company_id: company.id,
      monitor_id: null,
      status: 'down',
      response_ms: Date.now() - startTime,
      http_status: null,
      region: 'github-actions',
    }
  }
}

async function batchWrite(results) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/monitoring_results`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SRK,
      Authorization: `Bearer ${SUPABASE_SRK}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(results),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Supabase write failed ${resp.status}: ${text}`)
  }
}

async function main() {
  console.log(`Starting monitoring run. Tiers: ${RUN_TIER3 ? '2,3' : '2'}`)

  const companies = await loadCompanies()
  console.log(`Loaded ${companies.length} companies`)

  if (companies.length === 0) {
    console.log('No companies to monitor')
    return
  }

  const limit = pLimit(50)
  const results = await Promise.all(
    companies.map((company) => limit(() => pingUrl(company)))
  )

  const upCount = results.filter((r) => r.status === 'up').length
  const downCount = results.filter((r) => r.status === 'down').length
  console.log(`Results: ${upCount} up, ${downCount} down`)

  await batchWrite(results)
  console.log(`Wrote ${results.length} results to Supabase`)
}

main().catch((e) => {
  console.error('Monitor run failed:', e)
  process.exit(1)
})
