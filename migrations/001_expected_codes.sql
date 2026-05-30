-- 2026-05-29 — P0-3 (4xx-as-UP fix)
-- Per-company override for which HTTP status codes count as "healthy".
-- NULL  => default policy applies (2xx/3xx = up; 4xx/5xx = down).
-- e.g.  => '{403}' whitelists a site that legitimately returns 403 to our probe.
-- Read by: sentinel-core/worker (loadCompaniesFromSupabase) and sentinel-master/monitor.js (loadCompanies).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS expected_codes integer[];
