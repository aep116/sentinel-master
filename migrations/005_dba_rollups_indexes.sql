-- 2026-05-30 — DBA infrastructure: indexes, rollups, agent_learnings, refresh RPC.
-- NOTE: monitoring_results uses checked_at + response_ms (NOT created_at/response_time_ms);
-- companies.id is a text slug, so rollup company_id is text (not uuid).

-- Missing global time index (the others already exist as idx_monitoring_results_company/_status).
CREATE INDEX IF NOT EXISTS idx_monitoring_results_checked_at_desc ON monitoring_results (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_active_tier ON companies (active, tier) WHERE active = true;

CREATE TABLE IF NOT EXISTS rollups_hourly (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id text NOT NULL, hour_start timestamptz NOT NULL,
  total_checks integer DEFAULT 0, successful_checks integer DEFAULT 0, failed_checks integer DEFAULT 0,
  avg_response_ms numeric, min_response_ms numeric, max_response_ms numeric, uptime_pct numeric,
  created_at timestamptz DEFAULT now(), UNIQUE(company_id, hour_start));
CREATE TABLE IF NOT EXISTS rollups_daily (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id text NOT NULL, day_start date NOT NULL,
  total_checks integer DEFAULT 0, successful_checks integer DEFAULT 0, failed_checks integer DEFAULT 0,
  avg_response_ms numeric, uptime_pct numeric, incident_count integer DEFAULT 0, total_downtime_minutes integer DEFAULT 0,
  created_at timestamptz DEFAULT now(), UNIQUE(company_id, day_start));
CREATE TABLE IF NOT EXISTS agent_learnings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_name text NOT NULL, pattern_key text NOT NULL, learned_value jsonb NOT NULL,
  observations integer DEFAULT 0, hits integer DEFAULT 0, misses integer DEFAULT 0, confidence numeric DEFAULT 0,
  last_seen timestamptz DEFAULT now(), status text DEFAULT 'proposed', created_at timestamptz DEFAULT now(),
  UNIQUE(agent_name, pattern_key));
CREATE INDEX IF NOT EXISTS idx_rollups_hourly_company ON rollups_hourly (company_id, hour_start DESC);
CREATE INDEX IF NOT EXISTS idx_rollups_daily_company ON rollups_daily (company_id, day_start DESC);
CREATE INDEX IF NOT EXISTS idx_agent_learnings_agent ON agent_learnings (agent_name, status);
ALTER TABLE rollups_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollups_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_learnings ENABLE ROW LEVEL SECURITY;

-- Incremental rollup refresh (called nightly by scripts/dba-agent.mjs).
CREATE OR REPLACE FUNCTION refresh_recent_rollups() RETURNS void LANGUAGE sql AS $func$
  INSERT INTO rollups_hourly (company_id,hour_start,total_checks,successful_checks,failed_checks,avg_response_ms,min_response_ms,max_response_ms,uptime_pct)
  SELECT company_id, date_trunc('hour',checked_at), count(*), count(*) filter (where status='up'), count(*) filter (where status<>'up'),
         round(avg(response_ms)), min(response_ms), max(response_ms), round(count(*) filter (where status='up')::numeric/count(*)::numeric*100,2)
  FROM monitoring_results WHERE checked_at > now() - interval '25 hours' GROUP BY company_id, date_trunc('hour',checked_at)
  ON CONFLICT (company_id,hour_start) DO UPDATE SET total_checks=excluded.total_checks, successful_checks=excluded.successful_checks,
    failed_checks=excluded.failed_checks, avg_response_ms=excluded.avg_response_ms, min_response_ms=excluded.min_response_ms,
    max_response_ms=excluded.max_response_ms, uptime_pct=excluded.uptime_pct;
  INSERT INTO rollups_daily (company_id,day_start,total_checks,successful_checks,failed_checks,avg_response_ms,uptime_pct)
  SELECT company_id, date_trunc('day',checked_at)::date, count(*), count(*) filter (where status='up'), count(*) filter (where status<>'up'),
         round(avg(response_ms)), round(count(*) filter (where status='up')::numeric/count(*)::numeric*100,2)
  FROM monitoring_results WHERE checked_at > now() - interval '2 days' GROUP BY company_id, date_trunc('day',checked_at)::date
  ON CONFLICT (company_id,day_start) DO UPDATE SET total_checks=excluded.total_checks, successful_checks=excluded.successful_checks,
    failed_checks=excluded.failed_checks, avg_response_ms=excluded.avg_response_ms, uptime_pct=excluded.uptime_pct;
$func$;
