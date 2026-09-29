#!/usr/bin/env bash
# Mint a signed, expiring playback URL for a private video.  scripts/token.sh <id> [ttl-seconds]
set -euo pipefail
cd "$(dirname "$0")/.."
base=${MEDIA_URL:-http://127.0.0.1:5250}
secret=${ADMIN_SECRET:-$(sed -n 's/^ADMIN_SECRET=//p' .dev.vars)}
curl -sf -X POST "$base/admin/token" -H "Authorization: Bearer $secret" \
  -H 'Content-Type: application/json' -d "{\"video\":\"${1:?id}\",\"ttl\":${2:-3600}}"
echo
