/**
 * Fire an email alert via the frontend's internal endpoint (/api/alerts/check),
 * which sends through Resend. Never throws — an email failure must not crash
 * monitoring. Skips quietly if FRONTEND_ALERT_URL / ALERT_EMAIL are not set.
 *
 * Env is read at call time (not module load) so tests can configure it.
 *
 * @param {{type: string, company_or_site: string, url?: string, duration_min?: number,
 *          response_ms?: number, baseline_ms?: number, pct_above?: number,
 *          ssl_days_left?: number, email?: string}} payload
 * @returns {Promise<boolean>} true if the endpoint accepted the alert
 */
export async function sendEmailAlert(payload) {
  const base = process.env.FRONTEND_ALERT_URL
  const to = payload.email || process.env.ALERT_EMAIL
  if (!base || !to) {
    console.log('[Email] FRONTEND_ALERT_URL/ALERT_EMAIL not set — skipping email alert')
    return false
  }
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/api/alerts/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sentinel-internal': '1' },
      body: JSON.stringify({ ...payload, email: to }),
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      console.error(`[Email] alert failed: ${resp.status} — ${await resp.text()}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[Email] error:', err.message)
    return false // never throw — email failure must not crash monitoring
  }
}
