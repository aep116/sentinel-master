import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { detectSpike, isStatusDown, pingUrl, cacheBust, isDegraded, emaUpdate, classifyRun, decideIncidentAction } from './monitor.js'
import { sendEmailAlert } from './scripts/email.js'
import { shouldAlertSSL, getCertDaysLeft } from './scripts/ssl-check.js'
import { buildDegradationAlert } from './scripts/telegram.js'

function makeResults(upCount, downCount) {
  return [
    ...Array(upCount).fill({ status: 'up' }),
    ...Array(downCount).fill({ status: 'down' }),
  ]
}

// --- Spike detection ---

test('no failures: no spike', () => {
  assert.equal(detectSpike(makeResults(500, 0)), false)
})

test('1 company down out of 500 (0.2%): no spike', () => {
  assert.equal(detectSpike(makeResults(499, 1)), false)
})

test('typical bad day: 9 down out of 500 (1.8%): no spike', () => {
  assert.equal(detectSpike(makeResults(491, 9)), false)
})

test('genuine AWS outage: 30 down out of 500 (6%): no spike', () => {
  assert.equal(detectSpike(makeResults(470, 30)), false)
})

test('large CDN outage: 80 down out of 500 (16%): no spike', () => {
  assert.equal(detectSpike(makeResults(420, 80)), false)
})

test('exactly at threshold: 100 down out of 500 (20%): spike', () => {
  assert.equal(detectSpike(makeResults(400, 100)), true)
})

test('above threshold: 150 down out of 500 (30%): spike', () => {
  assert.equal(detectSpike(makeResults(350, 150)), true)
})

test('half failing (50%): spike', () => {
  assert.equal(detectSpike(makeResults(250, 250)), true)
})

test('all failing (100%) — CF Worker down: spike', () => {
  assert.equal(detectSpike(makeResults(0, 500)), true)
})

// --- Edge cases ---

test('empty results: no spike', () => {
  assert.equal(detectSpike([]), false)
})

test('single company up: no spike', () => {
  assert.equal(detectSpike(makeResults(1, 0)), false)
})

test('single company down: spike (100%)', () => {
  assert.equal(detectSpike(makeResults(0, 1)), true)
})

test('custom threshold: 10 down out of 100 at 0.10 threshold: spike', () => {
  assert.equal(detectSpike(makeResults(90, 10), 0.10), true)
})

test('custom threshold: 9 down out of 100 at 0.10 threshold: no spike', () => {
  assert.equal(detectSpike(makeResults(91, 9), 0.10), false)
})

// --- Regression: normal alert path unaffected ---

test('regression: normal run with 5 down stays below spike threshold', () => {
  const results = makeResults(495, 5)
  assert.equal(detectSpike(results), false)
  // Verify the down results are still present for alert processing
  const downResults = results.filter(r => r.status === 'down')
  assert.equal(downResults.length, 5)
})

test('regression: all up run returns correct counts', () => {
  const results = makeResults(508, 0)
  assert.equal(detectSpike(results), false)
  assert.equal(results.filter(r => r.status === 'up').length, 508)
  assert.equal(results.filter(r => r.status === 'down').length, 0)
})

test('regression: mixed results preserve status values', () => {
  const results = makeResults(490, 10)
  assert.equal(results.filter(r => r.status === 'up').length, 490)
  assert.equal(results.filter(r => r.status === 'down').length, 10)
  assert.equal(detectSpike(results), false)
})

// --- P0-3: 4xx-as-UP fix — isStatusDown (deterministic) ---

test('isStatusDown: 200 OK is up', () => { assert.equal(isStatusDown(200), false) })
test('isStatusDown: 301/302/304 redirects are up', () => {
  assert.equal(isStatusDown(301), false)
  assert.equal(isStatusDown(302), false)
  assert.equal(isStatusDown(304), false)
})
test('isStatusDown: 401 auth wall is DOWN', () => { assert.equal(isStatusDown(401), true) })
test('isStatusDown: 403 WAF/bot-block is DOWN', () => { assert.equal(isStatusDown(403), true) })
test('isStatusDown: 404 is DOWN', () => { assert.equal(isStatusDown(404), true) })
test('isStatusDown: 429 throttle is DOWN', () => { assert.equal(isStatusDown(429), true) })
test('isStatusDown: 500/503 are DOWN', () => {
  assert.equal(isStatusDown(500), true)
  assert.equal(isStatusDown(503), true)
})
test('isStatusDown: expected_codes whitelist overrides default (403 -> up)', () => {
  assert.equal(isStatusDown(403, [403]), false)
})
test('isStatusDown: expected_codes makes a non-listed 200 DOWN', () => {
  assert.equal(isStatusDown(200, [201, 204]), true)
})
test('isStatusDown: empty expected_codes falls back to default policy', () => {
  assert.equal(isStatusDown(403, []), true)
  assert.equal(isStatusDown(200, []), false)
})

// --- P0-3: real-URL integration ---
// Deterministic: a local HTTP server returns the status code in the path (real TCP/HTTP
// round-trip via pingUrl's fetch), plus one genuine-internet smoke test against example.com.

let server
let base
let lastReq = null
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      lastReq = { url: req.url, headers: req.headers, body }
      const code = Number.parseInt(req.url.replace('/', ''), 10) || 200
      res.writeHead(code, { 'Content-Type': 'text/plain' })
      res.end(`status ${code}`)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

test('pingUrl real: example.com (200) -> up', { timeout: 20000 }, async () => {
  const r = await pingUrl({ id: 'ex', url: 'https://example.com' })
  assert.equal(r.status, 'up')
})
test('pingUrl real(local): 200 -> up, http_status recorded', async () => {
  const r = await pingUrl({ id: 't200', url: `${base}/200` })
  assert.equal(r.status, 'up')
  assert.equal(r.http_status, 200)
})
test('pingUrl real(local): 403 WAF/bot-block -> down (was a false negative before fix)', async () => {
  const r = await pingUrl({ id: 't403', url: `${base}/403` })
  assert.equal(r.status, 'down')
  assert.equal(r.http_status, 403)
})
test('pingUrl real(local): 404 -> down', async () => {
  const r = await pingUrl({ id: 't404', url: `${base}/404` })
  assert.equal(r.status, 'down')
})
test('pingUrl real(local): 429 throttle -> down', async () => {
  const r = await pingUrl({ id: 't429', url: `${base}/429` })
  assert.equal(r.status, 'down')
})
test('pingUrl real(local): 500 -> down', async () => {
  const r = await pingUrl({ id: 't500', url: `${base}/500` })
  assert.equal(r.status, 'down')
})
test('pingUrl real(local): expected_codes [403] override makes 403 -> up', async () => {
  const r = await pingUrl({ id: 't403ok', url: `${base}/403`, expected_codes: [403] })
  assert.equal(r.status, 'up')
})

// --- A3: CDN cache-busting ---

test('cacheBust appends _st, preserves existing query', () => {
  assert.match(cacheBust('https://x.test/a?b=1'), /[?&]b=1/)
  assert.match(cacheBust('https://x.test/a?b=1'), /[?&]_st=\d+/)
})
test('pingUrl sends cache-bust param + no-cache headers', async () => {
  await pingUrl({ id: 'cb', url: `${base}/200` })
  assert.ok(lastReq)
  assert.match(lastReq.url, /[?&]_st=\d+/)
  assert.match(String(lastReq.headers['cache-control']), /no-cache/)
  assert.equal(lastReq.headers['pragma'], 'no-cache')
})

// --- C1: email alert path wiring (P0-9) ---

test('sendEmailAlert: POSTs to /api/alerts/check with internal header + payload', async () => {
  process.env.FRONTEND_ALERT_URL = base
  process.env.ALERT_EMAIL = 'ops@test.local'
  const ok = await sendEmailAlert({ type: 'outage', company_or_site: 'Acme', url: 'https://acme.test' })
  assert.equal(ok, true)
  assert.match(lastReq.url, /\/api\/alerts\/check$/)
  assert.equal(lastReq.headers['x-sentinel-internal'], '1')
  const sent = JSON.parse(lastReq.body)
  assert.equal(sent.type, 'outage')
  assert.equal(sent.company_or_site, 'Acme')
  assert.equal(sent.email, 'ops@test.local')
  delete process.env.FRONTEND_ALERT_URL
  delete process.env.ALERT_EMAIL
})
test('sendEmailAlert: returns false (never throws) when unconfigured', async () => {
  delete process.env.FRONTEND_ALERT_URL
  delete process.env.ALERT_EMAIL
  const ok = await sendEmailAlert({ type: 'outage', company_or_site: 'X' })
  assert.equal(ok, false)
})

// --- C2: SSL expiry check (P0-11) ---

test('shouldAlertSSL: fires at threshold days (30/14/7/3/1) and when expired', () => {
  for (const d of [30, 14, 7, 3, 1, 0, -5]) assert.equal(shouldAlertSSL(d), true, `days=${d}`)
})
test('shouldAlertSSL: silent on non-threshold days and unknown', () => {
  for (const d of [45, 20, 8, 2]) assert.equal(shouldAlertSSL(d), false, `days=${d}`)
  assert.equal(shouldAlertSSL(null), false)
  assert.equal(shouldAlertSSL(undefined), false)
})
test('getCertDaysLeft real: example.com returns a positive day count', { timeout: 20000 }, async () => {
  const days = await getCertDaysLeft('example.com')
  assert.equal(typeof days, 'number')
  assert.ok(days > 0, `expected >0, got ${days}`)
})
test('getCertDaysLeft: unreachable host resolves null (never throws)', { timeout: 20000 }, async () => {
  const days = await getCertDaysLeft('does-not-exist.invalid', 3000)
  assert.equal(days, null)
})

// --- C3: response-time degradation (P0-10) ---

test('isDegraded: >200% of baseline after warmup is degraded', () => {
  assert.equal(isDegraded(250, 100, 30), true)
  assert.equal(isDegraded(201, 100, 30), true)
})
test('isDegraded: within 200% is not degraded', () => {
  assert.equal(isDegraded(150, 100, 30), false)
  assert.equal(isDegraded(200, 100, 30), false)
})
test('isDegraded: suppressed during warmup (<=20 checks) and without a baseline', () => {
  assert.equal(isDegraded(500, 100, 10), false) // warmup
  assert.equal(isDegraded(500, 100, 20), false) // exactly at warmup boundary
  assert.equal(isDegraded(500, null, 50), false) // no baseline yet
})
test('emaUpdate: seeds with first value, then 98/2 weighted', () => {
  assert.equal(emaUpdate(null, 200), 200)
  assert.equal(emaUpdate(100, 200), 102) // round(100*0.98 + 200*0.02)
})
test('buildDegradationAlert: includes company, current, baseline, pct', () => {
  const msg = buildDegradationAlert({ name: 'Acme', url: 'https://acme.test' }, 400, 100, 300)
  assert.match(msg, /DEGRADED/)
  assert.match(msg, /Acme/)
  assert.match(msg, /400ms/)
  assert.match(msg, /100ms/)
  assert.match(msg, /300%/)
})

// --- P0-6: spike classification (infra-suppress vs broad-outage banner) ---

test('classifyRun: <20% normal, 20-80% spike (still alerts), >=80% infra (suppress)', () => {
  assert.equal(classifyRun(0.05), 'normal')
  assert.equal(classifyRun(0.19), 'normal')
  assert.equal(classifyRun(0.20), 'spike')
  assert.equal(classifyRun(0.50), 'spike') // real cloud-region outage: NOT suppressed anymore
  assert.equal(classifyRun(0.79), 'spike')
  assert.equal(classifyRun(0.80), 'infra')
  assert.equal(classifyRun(1.0), 'infra')
})

// --- P0-4: body validation (Tier 2/3); local server body is `status <code>` ---

test('pingUrl body: missing required keyword -> down even on 200', async () => {
  const r = await pingUrl({ id: 'k1', url: `${base}/200`, response_keyword: 'Operational' })
  assert.equal(r.status, 'down')
})
test('pingUrl body: present required keyword -> up', async () => {
  const r = await pingUrl({ id: 'k2', url: `${base}/200`, response_keyword: 'status' })
  assert.equal(r.status, 'up')
})
test('pingUrl body: forbidden keyword present -> down', async () => {
  const r = await pingUrl({ id: 'k3', url: `${base}/200`, response_forbidden_keyword: 'status' })
  assert.equal(r.status, 'down')
})
test('pingUrl body: no keyword config leaves 200 as up', async () => {
  const r = await pingUrl({ id: 'k4', url: `${base}/200` })
  assert.equal(r.status, 'up')
})

// --- P0-8: incident lifecycle / dedup ---

const HOUR_MS = 60 * 60 * 1000
test('decideIncidentAction: sustained down with no open incident -> open', () => {
  assert.equal(decideIncidentAction({ down: true, up: false, openIncident: null, now: 1_000_000 }), 'open')
})
test('decideIncidentAction: down while incident open (within cooldown) -> none (dedup)', () => {
  const now = 2_000_000
  const openIncident = { last_alert_at: new Date(now - 5 * 60 * 1000).toISOString() }
  assert.equal(decideIncidentAction({ down: true, up: false, openIncident, now }), 'none')
})
test('decideIncidentAction: down while incident open past cooldown -> realert (escalation)', () => {
  const now = 5_000_000
  const openIncident = { last_alert_at: new Date(now - 2 * HOUR_MS).toISOString() }
  assert.equal(decideIncidentAction({ down: true, up: false, openIncident, now }), 'realert')
})
test('decideIncidentAction: up with an open incident -> resolve', () => {
  const now = 9_000_000
  const openIncident = { last_alert_at: new Date(now).toISOString() }
  assert.equal(decideIncidentAction({ down: false, up: true, openIncident, now }), 'resolve')
})
test('decideIncidentAction: up with no open incident -> none', () => {
  assert.equal(decideIncidentAction({ down: false, up: true, openIncident: null, now: 1 }), 'none')
})
test('decideIncidentAction: single blip (down=false, not yet at threshold) -> none', () => {
  assert.equal(decideIncidentAction({ down: false, up: false, openIncident: null, now: 1 }), 'none')
})

// --- P0-12: region stamping (quorum/liveness prep) ---

test('pingUrl stamps the monitor region (default github-actions)', async () => {
  const r = await pingUrl({ id: 'rg', url: `${base}/200` })
  assert.equal(r.region, 'github-actions')
})
