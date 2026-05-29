"""
Upsert company-registry.json into Supabase companies table.
Uses ON CONFLICT (id) DO UPDATE via Prefer: resolution=merge-duplicates header.
Batches 100 rows at a time.
"""
import json, urllib.request, urllib.error, time, sys

SUPABASE_URL = "https://gpjzyxetrjloztmabigw.supabase.co"
REGISTRY = r"C:\Users\aep11\OneDrive\Git\Sentinel\GitHub\sentinel-master\company-registry.json"

def get_service_key() -> str:
    # Accept key via env var SUPABASE_SERVICE_KEY (set by caller)
    import os
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not key:
        raise RuntimeError("Set SUPABASE_SERVICE_KEY env var before running")
    return key

def upsert_batch(rows: list, key: str) -> int:
    payload = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/companies",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  HTTP {e.code}: {body[:200]}")
        return e.code

def main():
    print("Fetching service role key...")
    key = get_service_key()
    print("Key obtained.")

    with open(REGISTRY) as f:
        companies = json.load(f)

    # Map registry fields to table columns
    rows = []
    for c in companies:
        rows.append({
            "id": c["id"],
            "name": c["name"],
            "url": c["url"],
            "category": c["category"],
            "tier": c.get("tier", 2),
            "logo_url": c.get("logo_url"),
            "active": True,
        })

    BATCH = 100
    total = len(rows)
    inserted = 0
    for i in range(0, total, BATCH):
        batch = rows[i:i+BATCH]
        status = upsert_batch(batch, key)
        inserted += len(batch)
        print(f"  Batch {i//BATCH + 1}: {len(batch)} rows -> HTTP {status} ({inserted}/{total})")
        if status >= 400:
            print("Aborting on error.")
            sys.exit(1)
        time.sleep(0.1)

    print(f"\nDone. {total} rows upserted.")

if __name__ == "__main__":
    main()
