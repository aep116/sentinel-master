const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

/**
 * Send a Telegram message. Never throws — failure must not crash monitoring.
 * @param {string} message HTML-formatted message text
 */
export async function sendTelegram(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Credentials not set — skipping alert')
    return
  }

  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      console.error(`[Telegram] Failed to send message: ${response.status} — ${body}`)
    }
  } catch (err) {
    console.error('[Telegram] Error:', err.message)
    // Never throw — Telegram failure must not crash monitoring
  }
}

export function buildDownAlert(company, consecutiveFailures, statusDesc) {
  const now = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
  return (
    `🔴 <b>SENTINEL ALERT — SITE DOWN</b>\n\n` +
    `<b>Company:</b> ${company.name}\n` +
    `<b>URL:</b> ${company.url}\n` +
    `<b>Status:</b> ${statusDesc}\n` +
    `<b>Down since:</b> ${now} EST\n` +
    `<b>Consecutive failures:</b> ${consecutiveFailures}`
  )
}

export function buildRecoveryAlert(company, durationMin, responseMs) {
  return (
    `✅ <b>SENTINEL RECOVERY</b>\n\n` +
    `<b>Company:</b> ${company.name}\n` +
    `<b>URL:</b> ${company.url}\n` +
    `<b>Status:</b> Back online\n` +
    `<b>Response time:</b> ${responseMs}ms\n` +
    `<b>Down duration:</b> ${durationMin} minutes\n\n` +
    `Incident logged to Supabase.`
  )
}

export function buildSpikeAlert(downCount, totalCount) {
  const pct = Math.round((downCount / totalCount) * 100)
  return (
    `⚠️ <b>SENTINEL — SPIKE DETECTED, ALERTS SUPPRESSED</b>\n\n` +
    `<b>Failures:</b> ${downCount}/${totalCount} (${pct}%)\n` +
    `<b>Action:</b> Individual alerts suppressed. Data written to Supabase.\n` +
    `<b>Likely cause:</b> Monitoring infrastructure issue, not genuine mass outage.\n\n` +
    `Investigate CF Worker or GitHub Actions connectivity before next run.`
  )
}

export function buildSSLAlert(company, daysLeft) {
  return (
    `⚠️ <b>SSL EXPIRY WARNING</b>\n\n` +
    `<b>Company:</b> ${company.name}\n` +
    `<b>URL:</b> ${company.url}\n` +
    `<b>Cert expires:</b> ${daysLeft} days remaining\n\n` +
    `This is a leaderboard reliability signal.`
  )
}
