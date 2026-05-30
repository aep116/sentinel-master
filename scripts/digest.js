import { sendTelegram } from './telegram.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SRK = process.env.SUPABASE_SRK

if (!SUPABASE_URL || !SUPABASE_SRK) {
  console.error('Missing SUPABASE_URL or SUPABASE_SRK')
  process.exit(1)
}

async function fetchSupabase(path) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SRK,
      Authorization: `Bearer ${SUPABASE_SRK}`,
    },
  })
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`)
  return resp.json()
}

async function main() {
  const since = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString()
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  // Get companies list
  const companies = await fetchSupabase('companies?select=id,name,url,uptime_pct_30d&active=eq.true&order=uptime_pct_30d.desc')

  // Get recent monitoring results
  const results = await fetchSupabase(
    `monitoring_results?select=company_id,status,response_ms,checked_at&checked_at=gte.${encodeURIComponent(since)}&order=checked_at.desc`
  )

  // Build per-company stats
  const stats = {}
  for (const co of companies) {
    stats[co.id] = { name: co.name, url: co.url, uptime: co.uptime_pct_30d, downCount: 0, responseTimes: [], downMinutes: 0 }
  }

  for (const r of results) {
    if (!stats[r.company_id]) continue
    if (r.response_ms) stats[r.company_id].responseTimes.push(r.response_ms)
    if (r.status === 'down') stats[r.company_id].downCount++
  }

  const companyList = Object.values(stats)
  const online = companyList.filter((c) => c.downCount === 0)
  const incidents = companyList.filter((c) => c.downCount > 0)

  // Response time ranking
  const withAvg = companyList
    .filter((c) => c.responseTimes.length > 0)
    .map((c) => ({
      ...c,
      avgMs: Math.round(c.responseTimes.reduce((a, b) => a + b, 0) / c.responseTimes.length),
    }))
    .sort((a, b) => b.avgMs - a.avgMs)

  const slowest = withAvg.slice(0, 3)
  const fastest = withAvg.slice(-1)

  // Build message
  let msg = `📊 <b>SENTINEL OVERNIGHT REPORT</b>\n`
  msg += `<i>Last 8 hours — ${today}</i>\n\n`

  msg += `<b>STATUS SUMMARY</b>\n`
  msg += `✅ Online: ${online.length}/${companyList.length}\n`
  msg += `🔴 Incidents: ${incidents.length}\n\n`

  if (incidents.length > 0) {
    msg += `<b>INCIDENTS</b>\n`
    for (const inc of incidents) {
      const downMin = Math.round(inc.downCount * 5)
      msg += `• ${inc.name} — ${inc.downCount} failed checks (~${downMin} min)\n`
    }
    msg += '\n'
  }

  if (slowest.length > 0) {
    msg += `<b>RESPONSE TIMES</b>\n`
    for (const c of slowest) {
      msg += `🐌 ${c.name}: ${c.avgMs}ms avg\n`
    }
    if (fastest.length > 0 && fastest[0].avgMs < 200) {
      msg += `⚡ ${fastest[0].name}: ${fastest[0].avgMs}ms avg\n`
    }
    msg += '\n'
  }

  msg += `All data → ${process.env.SITE_URL || 'https://outageiq.io'}/leaderboard`

  console.log('Sending daily digest...')
  await sendTelegram(msg)
  console.log('Daily digest sent.')
}

main().catch((e) => {
  console.error('Digest failed:', e)
  process.exit(1)
})
