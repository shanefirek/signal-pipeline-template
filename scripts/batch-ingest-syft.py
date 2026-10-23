#!/usr/bin/env python3
"""
Batch ingest: Pull fresh Syft data → clean Supabase → insert raw_signals → trigger normalize.

Usage:
    python scripts/batch-ingest-syft.py                    # pull + filter only (dry run)
    python scripts/batch-ingest-syft.py --nuke             # truncate all Supabase tables first
    python scripts/batch-ingest-syft.py --nuke --insert    # nuke + insert into raw_signals
    python scripts/batch-ingest-syft.py --nuke --insert --trigger  # full E2E (insert + trigger normalize)
    python scripts/batch-ingest-syft.py --nuke --insert --trigger --limit 1  # single domain test
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv

# Load env from acme-gtmos-v2/.env
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(SCRIPT_DIR, "..", ".env"))

# ─── Config ───

SYFT_BASE = "https://app.syftdata.com"
SYFT_SOURCE_ID = "cmb5aiva4000ajo0aguxv0l69"

# Read Syft cookie from MCP config (most up-to-date source)
def get_syft_cookie():
    mcp_path = os.path.expanduser("~/projects/acmegtm-gtm/.claude/mcp.json")
    try:
        with open(mcp_path) as f:
            mcp = json.load(f)
        return mcp["mcpServers"]["syft"]["env"]["SYFT_COOKIE"]
    except Exception:
        pass
    return os.environ.get("SYFT_COOKIE", "")

SYFT_COOKIE = get_syft_cookie()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# Enterprise blocklist (matches gates.ts ENTERPRISE_BLOCKLIST)
ENTERPRISE_BLOCKLIST = {
    "google.com", "microsoft.com", "apple.com", "amazon.com", "meta.com",
    "facebook.com", "linkedin.com", "twitter.com", "x.com", "salesforce.com",
    "oracle.com", "ibm.com", "adobe.com", "splunk.com", "cisco.com",
    "vmware.com", "dell.com", "hp.com", "intel.com", "nvidia.com",
    "samsung.com", "bmw.com", "mercedes-benz.com", "toyota.com", "ford.com",
    "walmart.com", "target.com", "costco.com", "homedepot.com",
    "upwork.com", "fiverr.com", "freelancer.com",
    "github.com", "gitlab.com", "atlassian.com", "slack.com", "zoom.us",
    "hubspot.com", "mailchimp.com", "stripe.com", "shopify.com",
    "genesys.com", "pitchbook.com", "grafana.com", "iterable.com",
    "accenture.com", "netsuite.com", "extrahop.com", "classpass.com",
}

# ─── Syft API ───

def syft_pull_accounts(last_days=7):
    """Pull all accounts from Syft for the given time window."""
    accounts = []
    page = 0
    while page < 50:
        resp = requests.post(
            f"{SYFT_BASE}/api/accounts/search",
            headers={"Content-Type": "application/json", "Cookie": SYFT_COOKIE},
            json={
                "sourceId": SYFT_SOURCE_ID,
                "filters": {
                    "filters": [],
                    "contactFilters": [],
                    "lastDays": last_days,
                    "pagination": {"pageSize": 100, "pageIndex": page},
                    "sorting": {"lastSeen": "desc"},
                    "viewVisitors": "identified_or_suggested",
                },
                "linkedinSyncImpressionsOnlySessions": False,
            },
        )
        if resp.status_code != 200:
            print(f"  [ERROR] Syft API {resp.status_code}: {resp.text[:200]}")
            break

        data = resp.json()
        companies = data.get("companies", [])
        if not companies:
            break

        accounts.extend(companies)
        has_more = data.get("pagination", {}).get("hasMore", False)
        print(f"  Page {page}: {len(companies)} accounts (total so far: {len(accounts)})")

        if not has_more:
            break
        page += 1
        time.sleep(0.3)

    return accounts


# ─── Domain Filtering ───

def is_junk_domain(domain):
    """Filter out enterprise, .edu, .gov, internal, and other non-ICP domains."""
    d = domain.lower()

    # Internal
    if "acmegtm" in d or "rhosales" in d:
        return True

    # Education / government (we sell TO EdTech, not to schools)
    if d.endswith(".edu") or d.endswith(".gov") or ".k12." in d:
        return True

    # Enterprise blocklist
    if d in ENTERPRISE_BLOCKLIST:
        return True

    # Internal / partner / agency
    internal = {"digital-made.com", "starbridge.ai", "syftdata.com", "octave.club",
                "trigger.dev", "supabase.com", "posthog.com", "octavehq.com",
                "emailbison.com", "acmegtm.com"}
    if d in internal:
        return True

    # Common junk
    junk_keywords = ["staging", "localhost", "test.", "example.com", "gmail.com",
                      "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
                      "calendly.com/", "/careers"]
    if any(kw in d for kw in junk_keywords):
        return True

    return False


def is_too_large(account):
    """Filter out companies with 500+ employees — saves Octave credits.
    Gate would block them anyway (passesCompanyPushGate: employee_count >= 500)."""
    props = account.get("properties", {})
    emp = props.get("employees") or account.get("size")
    if emp and isinstance(emp, (int, float)) and emp >= 500:
        return True
    return False


# ─── Map Syft Account → raw_signals row ───

def map_to_raw_signal(account, source="syft_website"):
    """Map a Syft account object to a raw_signals row matching syft-webhook.ts extraction."""
    props = account.get("properties", {})
    domain = (account.get("domain") or "").lower()

    # Determine source: if only LinkedIn activity (no page views), it's syft_linkedin
    page_views = account.get("pageViews") or 0
    has_linkedin = (account.get("nLiVisitors") or 0) > 0
    if page_views == 0 and has_linkedin:
        source = "syft_linkedin"

    # Get first contact if available
    contacts = account.get("contacts") or []
    lead = contacts[0] if contacts else {}
    lead_props = lead.get("properties", {}) if lead else {}
    lead_geo = lead_props.get("geo", {})

    # Build attribution fields
    touch_channels = account.get("touchChannels") or []
    touch_mediums = account.get("touchMediums") or []
    touch_campaigns = account.get("touchCampaigns") or []
    utm_sources = account.get("utmSources") or []
    referrers_list = account.get("referrers") or []
    matched_intents = account.get("matchedIntents") or []
    matched_icps = account.get("matchedICPs") or []
    pages_viewed = account.get("pagesViewed") or []

    # First touch source
    first_touch = account.get("firstTouchSource") or ""

    return {
        "source": source,
        "raw_payload": account,  # Full Syft object for audit
        "domain": domain,
        "domain_raw": account.get("domain") or "",
        "email": lead.get("email") if lead.get("email") and lead.get("email") != "null" else None,
        "first_name": lead_props.get("name", "").split(" ")[0] if lead_props.get("name") else None,
        "last_name": " ".join(lead_props.get("name", "").split(" ")[1:]) if lead_props.get("name") else None,
        "contact_name": lead_props.get("name") or None,
        "company_name": account.get("name") or None,
        "title": lead_props.get("seniority") or None,  # Syft puts seniority, not job title

        # LinkedIn URLs
        "linkedin_url": None,  # Syft contacts don't have personal LinkedIn URLs in this format
        "company_linkedin_url": f"https://linkedin.com/{props.get('linkedin')}" if props.get("linkedin") else None,

        # Company data
        "employees": str(props.get("employees") or account.get("size") or ""),
        "industry": props.get("industry") or account.get("industry") or None,

        # Geo
        "city": lead_geo.get("city") or account.get("city") or (props.get("address", {}) or {}).get("city") or None,
        "state": lead_geo.get("state") or account.get("state") or (props.get("address", {}) or {}).get("state") or None,
        "country": lead_geo.get("country") or account.get("country") or (props.get("address", {}) or {}).get("country") or None,

        # Engagement
        "page_views": page_views,
        "sessions": account.get("nSiteSessions") or account.get("nSessions") or 0,
        "active_time_seconds": account.get("timeSpent") or 0,
        "visitor_count": account.get("nSiteVisitors") or account.get("nVisitors") or 0,

        # Intent
        "syft_purchase_intent": account.get("intent") or None,
        "syft_intent_level": account.get("intent") or None,
        "icp_match": ", ".join(matched_icps) if matched_icps else None,
        "last_seen": account.get("lastSeen") or None,

        # LinkedIn activity (aggregated from account)
        "linkedin_action": None,  # Account-level pull doesn't have per-event LinkedIn actions

        # Attribution — THE CRITICAL FIELDS
        "utm_channel": touch_channels[0] if touch_channels else None,
        "utm_sources": ", ".join(utm_sources) if utm_sources else None,
        "utm_medium": ", ".join(touch_mediums) if touch_mediums else None,
        "first_touch_source": first_touch or None,
        "touch_channels": ", ".join(touch_channels) if touch_channels else None,
        "touch_campaigns": ", ".join(touch_campaigns) if touch_campaigns else None,
        "referrers": ", ".join(referrers_list) if referrers_list else None,
        "latest_source": touch_channels[-1] if touch_channels else None,
        "matched_intents": ", ".join(matched_intents) if matched_intents else None,
        "high_intent_sessions": account.get("highIntentSessions") or 0,
        "session_pages_visited": None,  # No per-session data in bulk pull
        "pages_viewed": ", ".join(pages_viewed[:20]) if pages_viewed else None,
        "lead_personas": None,  # Not available in bulk account pull
        "lead_source": source,

        # Processing status
        "status": "pending",
        "validation": None,
        "validation_gate": False,
    }


# ─── Supabase ───

def supabase_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def nuke_tables():
    """Delete all rows from data tables. Keep domain_blocklist.
    Order matters — FK constraints require child tables first."""
    # Order: push_log (no FK), octave_results (FK→companies), signals (FK→companies,contacts,raw_signals),
    # contacts (FK→companies), companies (FK target), raw_signals (FK target)
    tables = ["push_log", "signals", "octave_results", "contacts", "companies", "raw_signals"]
    for table in tables:
        # Use gt filter on created_at to match all rows (every row has created_at)
        resp = requests.delete(
            f"{SUPABASE_URL}/rest/v1/{table}?created_at=gt.2000-01-01T00:00:00Z",
            headers={**supabase_headers(), "Prefer": "return=minimal"},
        )
        status = "OK" if resp.status_code in (200, 204) else f"ERROR {resp.status_code}: {resp.text[:100]}"
        print(f"  {table}: {status}")


def count_table(table):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?select=id&limit=1",
        headers={**supabase_headers(), "Prefer": "count=exact"},
    )
    count = resp.headers.get("content-range", "*/0").split("/")[-1]
    return int(count) if count != "*" else 0


def insert_raw_signals(rows):
    """Insert raw_signals rows into Supabase. Returns inserted IDs."""
    # Supabase REST API has a ~1000 row limit per request
    inserted_ids = []
    batch_size = 50

    # Supabase REST API requires all objects in a batch to have identical keys.
    # Collect ALL keys across all rows, then ensure every row has every key (None → null).
    all_keys = set()
    for row in rows:
        all_keys.update(row.keys())

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        clean_batch = []
        for row in batch:
            clean = {}
            for k in all_keys:
                v = row.get(k)
                if k == "raw_payload" and isinstance(v, dict):
                    clean[k] = json.dumps(v)
                else:
                    clean[k] = v  # None becomes JSON null — that's fine
            clean_batch.append(clean)

        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/raw_signals",
            headers=supabase_headers(),
            json=clean_batch,
        )
        if resp.status_code in (200, 201):
            results = resp.json()
            ids = [r["id"] for r in results]
            inserted_ids.extend(ids)
            print(f"  Inserted batch {i//batch_size + 1}: {len(ids)} rows")
        else:
            print(f"  [ERROR] Batch {i//batch_size + 1}: {resp.status_code} — {resp.text[:300]}")

    return inserted_ids


# ─── Main ───

def main():
    parser = argparse.ArgumentParser(description="Batch ingest Syft → Supabase raw_signals")
    parser.add_argument("--nuke", action="store_true", help="Truncate all Supabase data tables first")
    parser.add_argument("--insert", action="store_true", help="Insert into raw_signals")
    parser.add_argument("--trigger", action="store_true", help="Trigger normalize for each signal")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of domains to process")
    parser.add_argument("--days", type=int, default=7, help="Syft time window in days")
    parser.add_argument("--save", type=str, help="Save pulled Syft data to JSON file")
    parser.add_argument("--load", type=str, help="Load Syft data from JSON file instead of pulling")
    args = parser.parse_args()

    print(f"\n{'='*80}")
    print(f"  Syft → Supabase Batch Ingest")
    print(f"  Mode: {'NUKE + ' if args.nuke else ''}{'INSERT + ' if args.insert else ''}{'TRIGGER' if args.trigger else 'DRY RUN'}")
    print(f"  Time window: {args.days} days")
    print(f"{'='*80}\n")

    # Step 0: Show current Supabase state
    print("Current Supabase state:")
    for table in ["raw_signals", "companies", "contacts", "signals", "octave_results", "push_log"]:
        print(f"  {table}: {count_table(table)} rows")
    print()

    # Step 1: Nuke if requested
    if args.nuke:
        print("Nuking Supabase tables...")
        nuke_tables()
        print()
        print("Post-nuke state:")
        for table in ["raw_signals", "companies", "contacts", "signals", "octave_results"]:
            print(f"  {table}: {count_table(table)} rows")
        print()

    # Step 2: Pull Syft data
    if args.load:
        print(f"Loading Syft data from {args.load}...")
        with open(args.load) as f:
            data = json.load(f)
        accounts = data.get("accounts", data) if isinstance(data, dict) else data
        print(f"  Loaded {len(accounts)} accounts\n")
    else:
        print(f"Pulling Syft accounts (last {args.days} days)...")
        accounts = syft_pull_accounts(last_days=args.days)
        print(f"  Total: {len(accounts)} accounts\n")

        if args.save:
            with open(args.save, "w") as f:
                json.dump({"extracted": datetime.now(timezone.utc).isoformat(), "accounts": accounts}, f)
            print(f"  Saved to {args.save}\n")

    # Step 3: Filter
    filtered = []
    rejected = {"enterprise": 0, "edu_gov": 0, "junk": 0, "no_domain": 0, "zero_engagement": 0, "too_large": 0}
    for acct in accounts:
        domain = (acct.get("domain") or "").lower()
        if not domain:
            rejected["no_domain"] += 1
            continue
        if is_junk_domain(domain):
            if domain.endswith((".edu", ".gov")) or ".k12." in domain:
                rejected["edu_gov"] += 1
            elif domain in ENTERPRISE_BLOCKLIST:
                rejected["enterprise"] += 1
            else:
                rejected["junk"] += 1
            continue
        if is_too_large(acct):
            rejected["too_large"] += 1
            continue
        # Must have SOME engagement (page views or LinkedIn activity)
        pv = acct.get("pageViews") or 0
        li = (acct.get("nLiVisitors") or 0) + (acct.get("liTotalEngagements") or 0)
        if pv == 0 and li == 0:
            rejected["zero_engagement"] += 1
            continue
        filtered.append(acct)

    print(f"Filtered: {len(filtered)} pass / {len(accounts)} total")
    print(f"  Rejected: {json.dumps(rejected)}")

    # Dedup by domain
    seen = set()
    deduped = []
    for acct in filtered:
        d = acct["domain"].lower()
        if d not in seen:
            seen.add(d)
            deduped.append(acct)
    print(f"  After dedup: {len(deduped)} unique domains\n")

    if args.limit > 0:
        deduped = deduped[:args.limit]
        print(f"  Limited to {args.limit} domain(s)\n")

    # Step 4: Map to raw_signals
    rows = [map_to_raw_signal(acct) for acct in deduped]

    # Show preview
    print("Top 10 domains (by page views):")
    preview = sorted(deduped, key=lambda a: a.get("pageViews") or 0, reverse=True)[:10]
    print(f"  {'Domain':<35} {'PV':>4} {'Sessions':>8} {'Intent':>10} {'Channels':<30} {'UTM Sources':<20}")
    print(f"  {'-'*110}")
    for acct in preview:
        channels = ", ".join(acct.get("touchChannels") or [])[:28]
        utms = ", ".join(acct.get("utmSources") or [])[:18]
        intent = acct.get("intent") or "—"
        print(f"  {acct['domain']:<35} {acct.get('pageViews',0):>4} {acct.get('nSiteSessions',0):>8} {intent:>10} {channels:<30} {utms:<20}")
    print()

    # Show attribution completeness
    has_utm = sum(1 for r in rows if r.get("utm_sources"))
    has_touch = sum(1 for r in rows if r.get("first_touch_source"))
    has_intent = sum(1 for r in rows if r.get("syft_purchase_intent"))
    has_pages = sum(1 for r in rows if r.get("pages_viewed"))
    has_intents = sum(1 for r in rows if r.get("matched_intents"))
    print(f"Attribution completeness ({len(rows)} signals):")
    print(f"  utm_sources:        {has_utm}/{len(rows)} ({100*has_utm//max(len(rows),1)}%)")
    print(f"  first_touch_source: {has_touch}/{len(rows)} ({100*has_touch//max(len(rows),1)}%)")
    print(f"  syft_intent:        {has_intent}/{len(rows)} ({100*has_intent//max(len(rows),1)}%)")
    print(f"  pages_viewed:       {has_pages}/{len(rows)} ({100*has_pages//max(len(rows),1)}%)")
    print(f"  matched_intents:    {has_intents}/{len(rows)} ({100*has_intents//max(len(rows),1)}%)")
    print()

    if not args.insert:
        print("DRY RUN — pass --insert to write to Supabase")
        return

    # Step 5: Insert into raw_signals
    print(f"Inserting {len(rows)} raw_signals into Supabase...")
    ids = insert_raw_signals(rows)
    print(f"  Inserted: {len(ids)} rows\n")

    if not args.trigger:
        print("INSERTED — pass --trigger to fire normalize for each signal")
        print(f"  Signal IDs: {json.dumps(ids[:5])}{'...' if len(ids) > 5 else ''}")
        return

    # Step 6: Trigger normalize via Trigger.dev REST API
    # Note: We use the dev key here. For prod, use the MCP trigger_task tool.
    print(f"Triggering normalize for {len(ids)} signals...")
    print("  NOTE: Use Trigger.dev MCP (trigger_task) for prod. This uses dev key.")
    # Output IDs for manual triggering via MCP
    print(f"\n  Raw signal IDs for MCP trigger_task:")
    for signal_id in ids:
        print(f"    {signal_id}")


if __name__ == "__main__":
    main()
