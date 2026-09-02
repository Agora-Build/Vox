#!/usr/bin/env bash
# Download/refresh GeoIP databases for the zero-trust agent-region pipeline.
# Run weekly (cron / Coolify scheduled command). Missing DBs are non-fatal at
# runtime: agents simply stay Unverified.
#
# Two sources, both free:
#   maxmind (default when MAXMIND_LICENSE_KEY is set) — GeoLite2, best
#     accuracy; the key is a free-signup artifact, never a payment.
#   dbip (fallback when the key is unset, or forced via --source dbip) —
#     DB-IP Lite (CC-BY-4.0), no account or key needed; slightly less
#     accurate and lacks accuracy_radius. Files are saved under the server's
#     expected GeoLite2-*.mmdb names (server/location.ts loads those paths;
#     the MMDB format is identical).
set -euo pipefail

GEOIP_DB_DIR="${GEOIP_DB_DIR:-$(pwd)/geoip}"
mkdir -p "$GEOIP_DB_DIR"

SOURCE="auto"
if [ "${1:-}" = "--source" ] && [ -n "${2:-}" ]; then
  SOURCE="$2"
fi
if [ "$SOURCE" = "auto" ]; then
  if [ -n "${MAXMIND_LICENSE_KEY:-}" ]; then SOURCE="maxmind"; else SOURCE="dbip"; fi
fi

verify_mmdb() {
  test -s "${GEOIP_DB_DIR}/$1.mmdb" || { echo "ERROR: $1.mmdb missing/empty after extraction"; exit 1; }
  echo "  → ${GEOIP_DB_DIR}/$1.mmdb"
}

fetch_maxmind() {
  : "${MAXMIND_LICENSE_KEY:?Set MAXMIND_LICENSE_KEY (https://www.maxmind.com → GeoLite2 free account) or use --source dbip}"
  for edition in GeoLite2-City GeoLite2-ASN; do
    echo "Fetching ${edition} (MaxMind GeoLite2)..."
    tmp=$(mktemp -d)
    curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=${edition}&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
      -o "${tmp}/${edition}.tar.gz"
    tar -xzf "${tmp}/${edition}.tar.gz" -C "$tmp"
    find "$tmp" -name "${edition}.mmdb" -exec mv {} "${GEOIP_DB_DIR}/" \;
    rm -rf "$tmp"
    verify_mmdb "${edition}"
  done
}

# DB-IP publishes one file per month (dbip-city-lite-YYYY-MM.mmdb.gz). Early in
# a month the current file can 404 before publication, so fall back one month.
fetch_dbip_edition() {
  local dbip_name="$1" target="$2" month prev
  month=$(date -u +%Y-%m)
  prev=$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)
  tmp=$(mktemp -d)
  echo "Fetching ${dbip_name} (DB-IP Lite, no key)..."
  if ! curl -fsSL "https://download.db-ip.com/free/${dbip_name}-${month}.mmdb.gz" -o "${tmp}/db.mmdb.gz"; then
    echo "  ${month} not published yet, trying ${prev}..."
    curl -fsSL "https://download.db-ip.com/free/${dbip_name}-${prev}.mmdb.gz" -o "${tmp}/db.mmdb.gz"
  fi
  gunzip "${tmp}/db.mmdb.gz"
  mv "${tmp}/db.mmdb" "${GEOIP_DB_DIR}/${target}.mmdb"
  rm -rf "$tmp"
  verify_mmdb "${target}"
}

fetch_dbip() {
  fetch_dbip_edition "dbip-city-lite" "GeoLite2-City"
  fetch_dbip_edition "dbip-asn-lite" "GeoLite2-ASN"
  echo "Note: DB-IP Lite data (CC-BY-4.0, https://db-ip.com) saved under the server's expected filenames."
}

case "$SOURCE" in
  maxmind) fetch_maxmind ;;
  dbip)    fetch_dbip ;;
  *) echo "ERROR: unknown --source '$SOURCE' (expected maxmind or dbip)"; exit 1 ;;
esac

echo "Done. Restart the Vox server to load the new databases."
