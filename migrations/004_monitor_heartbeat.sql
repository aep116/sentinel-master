-- 2026-05-29 — P0-12 (monitor liveness)
-- Each monitoring run upserts its source's last_run_at. The frontend /api/health
-- endpoint reports staleness; an external watchdog polls it to catch a dead/disabled
-- cron (which GitHub/Cloudflare do not alert on). Internal table; service role only.
CREATE TABLE IF NOT EXISTS monitor_heartbeat (
  source text PRIMARY KEY,
  last_run_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE monitor_heartbeat ENABLE ROW LEVEL SECURITY;
