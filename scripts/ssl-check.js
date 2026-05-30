import { fileURLToPath } from 'url'
import tls from 'node:tls'
import pLimit from 'p-limit'
import { sendTelegram, buildSSLAlert } from './telegram.js'
import { sendEmailAlert } from './email.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SRK = process.env.SUPABASE_SRK

// Alert when the cert has exactly this many days left. A daily run fires at most
// ~5 times per cert (no per-company state needed), plus every run once expired.
export const SSL_ALERT_THRESHOLDS = [30, 14, 7, 3, 1]

export function shouldAlertSSL(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return false
  return daysLeft <= 0 || SSL_ALERT_THRESHOLDS.includes(daysLeft)
}

/**
 * Days until the TLS certificate for `hostname` expires. Resolves null on any
 * error (unreachable host, no cert, timeout) so a single bad host never crashes
 * the run. Never throws.
 * @param {string} hostname
 * @param {number} [timeoutMs]
 * @returns {Promise<number|null>}
 */
export function getCertDaysLeft(hostname, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const socket = tls.connect(
        { host: hostname, port: 443, servername: hostname, timeout: timeoutMs },
        () => {
          const cert = socket.getPeerCertificate()
          socket.end()
          if (!cert || !cert.valid_to) return done(null)
          const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)
          done(Number.isFinite(days) ? days : null)
        }
      )
      socket.on('error', () => done(null))
      socket.on('timeout', () => { socket.destroy(); done(null) })
    } catch {
      done(null)
    }
  })
}

async function loadCompanies() {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?active=eq.true&select=id,name,url`,
    { headers: { apikey: SUPABASE_SRK, Authorization: `Bearer ${SUPABASE_SRK}` } }
  )
  if (!resp.ok) throw new Error(`Failed to load companies: ${resp.status}`)
  return resp.json()
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SRK) {
    console.error('Missing SUPABASE_URL or SUPABASE_SRK env vars')
    process.exit(1)
  }
  const companies = await loadCompanies()
  console.log(`SSL check: ${companies.length} companies`)

  const limit = pLimit(20)
  let alerted = 0
  await Promise.all(
    companies.map((company) =>
      limit(async () => {
        let hostname
        try { hostname = new URL(company.url).hostname } catch { return }
        const days = await getCertDaysLeft(hostname)
        if (!shouldAlertSSL(days)) return
        alerted++
        console.log(`[SSL] ${company.name} (${hostname}) expires in ${days} days`)
        await Promise.all([
          sendTelegram(buildSSLAlert(company, days)),
          sendEmailAlert({ type: 'ssl_expiry', company_or_site: company.name, url: company.url, ssl_days_left: days }),
        ])
      })
    )
  )
  console.log(`SSL check done. ${alerted} cert(s) near expiry.`)
}

const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
  main().catch((e) => {
    console.error('SSL check failed:', e)
    process.exit(1)
  })
}
