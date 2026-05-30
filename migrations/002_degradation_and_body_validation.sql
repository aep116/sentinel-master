-- 2026-05-29 — P0-10 (degradation) + P0-4 (body validation)

-- P0-10: hysteresis flag so degradation alerts fire once on the not-degraded -> degraded
-- transition, not every run while slow.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS degraded boolean NOT NULL DEFAULT false;

-- P0-10: one call updates avg_response_ms / checks_count / degraded for every checked
-- company, instead of 500+ per-row PATCHes inside the 4-minute GitHub Actions budget.
CREATE OR REPLACE FUNCTION bulk_update_company_stats(updates jsonb)
RETURNS void LANGUAGE sql AS $func$
  UPDATE companies c SET
    avg_response_ms = (u->>'avg_response_ms')::int,
    checks_count    = (u->>'checks_count')::int,
    degraded        = (u->>'degraded')::boolean,
    last_checked_at = now()
  FROM jsonb_array_elements(updates) AS u
  WHERE c.id = (u->>'id');
$func$;

-- P0-4: per-company body validation. A 200 serving a maintenance/login/error page is
-- still down. NULL => no body check (status-code only).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS response_keyword text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS response_forbidden_keyword text;
