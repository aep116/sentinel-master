-- 2026-05-29 — P0-8 (incident lifecycle / alert dedup)
-- The incidents table already existed (id, company_id FK, monitor_id, started_at,
-- resolved_at, duration_min, ai_summary, x_post_id). "Open" = resolved_at IS NULL.
-- These additions add dedup + escalation tracking and enforce one open incident per company.

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS last_alert_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS alert_count int NOT NULL DEFAULT 1;

-- At most one OPEN incident per company — makes a duplicate "open" insert fail (409),
-- which is how the monitor dedups repeated down checks during one sustained outage.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_per_company
  ON incidents (company_id) WHERE resolved_at IS NULL;

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY; -- internal only; service role bypasses
