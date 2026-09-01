#!/usr/bin/env bash
# Download/refresh GeoLite2 databases for the zero-trust agent-region pipeline.
# Requires MAXMIND_LICENSE_KEY (free GeoLite2 account). Run weekly (cron /
# Coolify scheduled command). Missing DBs are non-fatal at runtime: agents
# simply stay Unverified.
set -euo pipefail

: "${MAXMIND_LICENSE_KEY:?Set MAXMIND_LICENSE_KEY (https://www.maxmind.com → GeoLite2 free account)}"
GEOIP_DB_DIR="${GEOIP_DB_DIR:-$(pwd)/geoip}"
mkdir -p "$GEOIP_DB_DIR"

for edition in GeoLite2-City GeoLite2-ASN; do
  echo "Fetching ${edition}..."
  tmp=$(mktemp -d)
  curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=${edition}&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
    -o "${tmp}/${edition}.tar.gz"
  tar -xzf "${tmp}/${edition}.tar.gz" -C "$tmp"
  find "$tmp" -name "${edition}.mmdb" -exec mv {} "${GEOIP_DB_DIR}/" \;
  rm -rf "$tmp"
  echo "  → ${GEOIP_DB_DIR}/${edition}.mmdb"
done
echo "Done. Restart the Vox server to load the new databases."
