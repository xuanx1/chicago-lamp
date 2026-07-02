"""
Fetch newer rows from the Chicago Data Portal (Socrata) for the street-lamp
datasets configured in data/state.json, append them to the corresponding CSVs,
then re-run preprocess.py.

Pagination per: https://support.socrata.com/hc/en-us/articles/202949268
  - $limit max 50,000 per request
  - $offset for paging through
  - $order on a stable column (we use :id, the recommended cursor)
  - $where to filter incrementally by created/creation_date > local max

Sources (declared in data/state.json):
  legacy  - zuxi-7xem (all-out) and 3aav-uy2v (1-out). Both were frozen on
            2018-12-19 when Chicago migrated streetlight SRs into the unified
            311 dataset, so these fetches normally return 0 new rows.
  unified - v6vf-nfxy filtered to sr_type='Street Light Out Complaint'. This is
            the active source; rows are appended to current.csv.

Run:
  python fetch_updates.py                  # incremental since each source's last max
  python fetch_updates.py --since 2024-01-01
  python fetch_updates.py --only current   # restrict to one source key
  python fetch_updates.py --dry-run        # show counts; don't write CSVs

Optional: set SOCRATA_APP_TOKEN env var to raise the rate limit.
Get one at https://data.cityofchicago.org/profile/app_tokens.
"""
import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
STATE_PATH = os.path.join(DATA_DIR, "state.json")

PAGE_SIZE = 50000  # Socrata maximum per request
RESOURCE_URL = "https://data.cityofchicago.org/resource/{dataset_id}.json"

# Columns / field maps per schema. The CSV columns are listed in write order.

LEGACY_CSV_COLUMNS = [
    "Creation Date", "Status", "Completion Date", "Service Request Number",
    "Type of Service Request", "Street Address", "ZIP Code",
    "X Coordinate", "Y Coordinate", "Ward", "Police District",
    "Community Area", "Latitude", "Longitude", "Location",
]
LEGACY_API_TO_CSV = {
    "Creation Date": ("creation_date", "date"),
    "Status": ("status", "str"),
    "Completion Date": ("completion_date", "date"),
    "Service Request Number": ("service_request_number", "str"),
    "Type of Service Request": ("type_of_service_request", "str"),
    "Street Address": ("street_address", "str"),
    "ZIP Code": ("zip_code", "str"),
    "X Coordinate": ("x_coordinate", "str"),
    "Y Coordinate": ("y_coordinate", "str"),
    "Ward": ("ward", "str"),
    "Police District": ("police_district", "str"),
    "Community Area": ("community_area", "str"),
    "Latitude": ("latitude", "str"),
    "Longitude": ("longitude", "str"),
    "Location": ("location", "location"),
}
LEGACY_DATE_FIELD = "creation_date"

# Unified 311 dataset (v6vf-nfxy) - snake_case columns, ISO dates.
UNIFIED_CSV_COLUMNS = [
    "sr_number", "sr_type", "status", "created_date", "closed_date",
    "street_address", "zip_code", "ward", "community_area",
    "police_district", "latitude", "longitude",
]
UNIFIED_API_TO_CSV = {c: (c, "passthrough") for c in UNIFIED_CSV_COLUMNS}
UNIFIED_DATE_FIELD = "created_date"


def load_state():
    if not os.path.exists(STATE_PATH):
        print(f"! {STATE_PATH} not found. Run preprocess.py first.", file=sys.stderr)
        sys.exit(1)
    with open(STATE_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def fmt_floating_ts(iso_date):
    """'YYYY-MM-DD' -> 'YYYY-MM-DDT00:00:00.000' (Socrata floating timestamp)."""
    return f"{iso_date}T00:00:00.000"


def to_mmddyyyy(iso_ts):
    if not iso_ts:
        return ""
    s = iso_ts.split("T")[0]
    try:
        y, m, d = s.split("-")
        return f"{int(m):02d}/{int(d):02d}/{y}"
    except ValueError:
        return ""


def http_get_json(url, app_token=None):
    headers = {"Accept": "application/json", "User-Agent": "chicago-lamp-map/1.0"}
    if app_token:
        headers["X-App-Token"] = app_token
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def convert_value(api_row, api_field, kind):
    v = api_row.get(api_field, "")
    if kind == "date":
        return to_mmddyyyy(v)
    if kind == "location":
        if isinstance(v, dict):
            lat = v.get("latitude") or api_row.get("latitude") or ""
            lon = v.get("longitude") or api_row.get("longitude") or ""
            return f"({lat}, {lon})" if lat and lon else ""
        return v or ""
    if v is None:
        return ""
    return str(v)


def to_csv_row(api_row, field_map):
    return {csv_col: convert_value(api_row, api_field, kind)
            for csv_col, (api_field, kind) in field_map.items()}


def existing_sr_numbers(csv_path, sr_col):
    seen = set()
    if not os.path.exists(csv_path):
        return seen
    with open(csv_path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sr = (row.get(sr_col) or "").strip()
            if sr:
                seen.add(sr)
    return seen


def fetch_dataset(dataset_id, where, app_token=None, dry_run=False):
    offset = 0
    total = 0
    while True:
        params = {
            "$where": where,
            "$order": ":id",
            "$limit": PAGE_SIZE,
            "$offset": offset,
        }
        url = RESOURCE_URL.format(dataset_id=dataset_id) + "?" + urllib.parse.urlencode(params)
        print(f"    GET offset={offset:>7} ...", end=" ", flush=True)
        try:
            rows = http_get_json(url, app_token=app_token)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:300]
            print(f"HTTP {e.code} - {body}")
            return
        print(f"{len(rows)} rows")
        if not rows:
            return
        total += len(rows)
        yield rows
        if len(rows) < PAGE_SIZE:
            return
        offset += PAGE_SIZE
        if dry_run and offset >= PAGE_SIZE * 3:
            print("    (dry-run: stopping after 3 pages)")
            return


def append_rows(csv_path, rows, columns, seen_sr, sr_col):
    added = 0
    new_rows = []
    for r in rows:
        sr = (r.get(sr_col) or "").strip()
        if sr and sr in seen_sr:
            continue
        seen_sr.add(sr)
        new_rows.append(r)
        added += 1
    if not new_rows:
        return 0
    file_exists = os.path.exists(csv_path)
    with open(csv_path, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns, quoting=csv.QUOTE_ALL)
        if not file_exists:
            w.writeheader()
        for r in new_rows:
            w.writerow(r)
    return added


def fetch_one_source(key, info, args):
    schema = info["schema"]
    if schema == "legacy":
        field_map = LEGACY_API_TO_CSV
        columns = LEGACY_CSV_COLUMNS
        date_field = LEGACY_DATE_FIELD
        sr_col = "Service Request Number"
        where_extra = None
    elif schema == "unified":
        field_map = UNIFIED_API_TO_CSV
        columns = UNIFIED_CSV_COLUMNS
        date_field = UNIFIED_DATE_FIELD
        sr_col = "sr_number"
        sr_type = info.get("sr_type_filter")
        where_extra = f"sr_type='{sr_type}'" if sr_type else None
    else:
        print(f"  [{key}] unknown schema {schema!r}, skipping")
        return 0, None

    if info.get("frozen") and not args.force_frozen and not args.since:
        print(f"  [{key}] marked frozen; skipping (use --force-frozen or --since to override)")
        return 0, None

    since = args.since or info.get("max_creation_date") or "2010-01-01"
    where = f"{date_field} > '{fmt_floating_ts(since)}'"
    if where_extra:
        where = f"({where}) AND {where_extra}"

    csv_path = os.path.join(HERE, info["csvs"][-1])
    print(f"\n[{key}] {info['label']}  ({info['dataset_id']}, schema={schema})")
    print(f"  $where: {where}")

    seen_sr = existing_sr_numbers(csv_path, sr_col)
    added_total = 0
    max_seen = info.get("max_creation_date")

    try:
        for batch in fetch_dataset(info["dataset_id"], where, args.app_token, args.dry_run):
            for api_row in batch:
                dt = api_row.get(date_field, "")
                if dt:
                    iso_d = dt.split("T")[0]
                    if not max_seen or iso_d > max_seen:
                        max_seen = iso_d
            converted = [to_csv_row(r, field_map) for r in batch]
            if args.dry_run:
                added_total += len(converted)
            else:
                added_total += append_rows(csv_path, converted, columns, seen_sr, sr_col)
    except urllib.error.URLError as e:
        print(f"  ! network error: {e.reason}")
        return 0, None

    print(f"  {'would add' if args.dry_run else 'added'} {added_total} new rows to {info['csvs'][-1]}")
    return added_total, max_seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="ISO date YYYY-MM-DD (defaults to per-source max_creation_date)")
    ap.add_argument("--only", help="Only fetch the given source key (e.g. 'current')")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force-frozen", action="store_true",
                    help="Also fetch sources marked frozen (legacy datasets that stopped updating in 2018)")
    ap.add_argument("--app-token", default=os.environ.get("SOCRATA_APP_TOKEN"))
    ap.add_argument("--skip-preprocess", action="store_true")
    args = ap.parse_args()

    state = load_state()
    any_added = False

    for key, info in state.items():
        if args.only and key != args.only:
            continue
        added, max_seen = fetch_one_source(key, info, args)
        if added and not args.dry_run:
            any_added = True
            if max_seen:
                info["max_creation_date"] = max_seen
            save_state(state)

    if any_added and not args.skip_preprocess:
        print("\nRe-running preprocess.py to refresh viewer data...")
        import subprocess
        subprocess.check_call([sys.executable, os.path.join(HERE, "preprocess.py")])

    print(f"\nDone at {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
