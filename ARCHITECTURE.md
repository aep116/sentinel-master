# ARCHITECTURE.md — sentinel-master (aep116/sentinel-master)

## Role
Tier 2/3 company monitoring. Public. GitHub Actions workflow + company registry.
KiloClaw reads this file at the start of every maintenance session.

## What Lives Here
- .github/workflows/monitor-companies.yml — ONE workflow file only (5-min cron)
- monitor.js — monitoring logic with p-limit concurrency throttle
- company-registry.json — 500-company seed data (source of truth before Supabase import)

## What Does NOT Live Here
- No application code. No Supabase client libraries. No billing.
- Monitoring results go to Supabase (never committed to git).
- Secrets are GitHub Actions secrets only.

## Monitoring Architecture
This repo handles Tier 2 and Tier 3 checks.
- Tier 1: handled by sentinel-core (Cloudflare Workers, 1-min checks)
- Tier 2: this repo, 5-min cron, ~100 companies
- Tier 3: this repo, 15-min boundary check via RUN_TIER3 env, ~300 companies

ONE workflow handles both frequencies:
  on: schedule: cron: '*/5 * * * *'
  MINUTE check: RUN_TIER3=$([ $(( 10#$MINUTE % 15 )) -eq 0 ] && echo true || echo false)
  monitor.js reads RUN_TIER3 and filters companies by tier accordingly.

## Concurrency Throttle (REQUIRED)
p-limit(50) on all fetch() calls.
Without this: 200+ simultaneous fetches saturate GitHub Actions runner network.

  import pLimit from 'p-limit'
  const limit = pLimit(50)
  const results = await Promise.all(companies.map(c => limit(() => pingUrl(c))))

## Data Flow
1. monitor.js reads company list from Supabase (filter by tier)
2. Pings each URL with p-limit(50) concurrency
3. Batch POST all results to Supabase /rest/v1/monitoring_results
4. Results include: company_id, status, response_ms, http_status, region, checked_at
5. Never writes to company-registry.json from the workflow

## GitHub Actions Secrets Required
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- RESEND_API_KEY

## KiloClaw Rules
- Maximum 5 files per PR
- Read this file before every session
- Never add a second workflow file — one workflow only
- Company registry edits: update company-registry.json AND Supabase companies table
- Concurrency cap: never remove p-limit or raise above 50
