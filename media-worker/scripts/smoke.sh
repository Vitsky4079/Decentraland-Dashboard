#!/usr/bin/env bash
# End-to-end checks against a running worker (npm run dev) with `demo` (public) and
# `demo-private` (private) uploaded. Exits non-zero on any failure.
set -uo pipefail
cd "$(dirname "$0")/.."
B=${MEDIA_URL:-http://127.0.0.1:5250}
pass=0; fail=0
ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; fail=$((fail+1)); }
check(){ local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
hdr()  { curl -s -D - -o /dev/null "$@" | tr -d '\r'; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== web-explorer HLS detection (HEAD + Content-Type + CORS)"
h=$(hdr -I "$B/v/demo/master.m3u8")
check "HEAD master.m3u8 -> 200"               grep -q '^HTTP/1.1 200' <<<"$h"
check "Content-Type application/vnd.apple.mpegurl" grep -qi '^content-type: application/vnd.apple.mpegurl' <<<"$h"
check "Access-Control-Allow-Origin: *"        grep -qi '^access-control-allow-origin: \*' <<<"$h"
h=$(hdr -X OPTIONS -H 'Origin: https://play.decentraland.org' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: range' "$B/v/demo/720p/seg_000.m4s")
check "CORS preflight allows Range"           grep -qi '^access-control-allow-headers:.*range' <<<"$h"

echo "== ranges + caching"
h=$(hdr -H 'Range: bytes=0-1023' "$B/v/demo/video.mp4")
check "Range on video.mp4 -> 206"             grep -q '^HTTP/1.1 206' <<<"$h"
check "Content-Range bytes 0-1023/<size>"     grep -qi '^content-range: bytes 0-1023/[0-9]' <<<"$h"
check "Content-Length 1024"                   grep -qi '^content-length: 1024$' <<<"$h"
h=$(hdr -H 'Range: bytes=-500' "$B/v/demo/video.mp4")
check "suffix Range -> 206 len 500"           grep -qi '^content-length: 500$' <<<"$h"
# cache.put runs in waitUntil after the first response; allow a few tries.
hit=no; for _ in 1 2 3 4 5; do
  h=$(hdr "$B/v/demo/720p/seg_003.m4s"); grep -qi '^x-cache: HIT' <<<"$h" && { hit=yes; break; }
done
check "repeat segment GET is a cache HIT"     test $hit = yes
check "segments immutable"                    grep -qi '^cache-control:.*immutable' <<<"$h"
h=$(hdr "$B/v/demo/720p/index.m3u8")
check "VOD playlist max-age=60"               grep -qi '^cache-control: public, max-age=60' <<<"$h"

echo "== access control"
check "private video via /v/ -> 403"          test "$(code "$B/v/demo-private/master.m3u8")" = 403
url=$(scripts/token.sh demo-private 600 | node -pe 'JSON.parse(require("fs").readFileSync(0)).url')
tok=$(sed -E 's#.*/t/([^/]+)/v/.*#\1#' <<<"$url")
check "token URL -> 200"                      test "$(code "$url")" = 200
check "token covers relative segment URLs"    test "$(code "$B/t/$tok/v/demo-private/720p/seg_000.m4s")" = 200
check "token for other video -> 403"          test "$(code "$B/t/$tok/v/demo/master.m3u8")" = 403
check "tampered token -> 403"                 test "$(code "$B/t/${tok%?}A/v/demo-private/master.m3u8")" = 403
exp=$(scripts/token.sh demo-private -5 | node -pe 'JSON.parse(require("fs").readFileSync(0)).url')
check "expired token -> 403"                  test "$(code "$exp")" = 403
check "_meta.json not served"                 test "$(code "$B/v/demo/_meta.json")" = 404
check "admin without secret -> 401"           test "$(code -X PUT --data x "$B/admin/obj/demo/x.ts")" = 401

echo "== real decode through the worker (ffmpeg as the player)"
check "HLS ladder (public) decodes 8 s"       ffmpeg -v error -i "$B/v/demo/master.m3u8" -t 8 -f null -
check "HLS ladder (token) decodes 8 s"        ffmpeg -v error -i "$url" -t 8 -f null -
check "progressive MP4 decodes 8 s"           ffmpeg -v error -i "$B/v/demo/video.mp4" -t 8 -f null -

echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
