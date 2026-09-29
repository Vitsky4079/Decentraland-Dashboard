#!/usr/bin/env bash
# Live HLS into R2 through the Worker: ffmpeg's HLS muxer PUTs each segment and the
# rolling playlist to /admin/obj/<id>/…, and DELETEs segments that fall out of the window.
# In production the same command runs on an ingest box fed by OBS (RTMP/SRT) — Workers
# can't accept RTMP themselves.
#   scripts/live.sh <id> [input]       input defaults to a synthetic test pattern
#   e.g. input "rtmp://0.0.0.0:1935/live/key" with `-listen 1` to take OBS directly.
set -euo pipefail
cd "$(dirname "$0")/.."
id=${1:?id}; shift
base=${MEDIA_URL:-http://127.0.0.1:5250}
secret=${ADMIN_SECRET:-$(sed -n 's/^ADMIN_SECRET=//p' .dev.vars)}
if [ $# -gt 0 ]; then src=("$@"); else
  src=(-re -f lavfi -i "testsrc2=size=1280x720:rate=30" -re -f lavfi -i "sine=frequency=330")
fi
curl -sf -X PUT "$base/admin/meta/$id" -H "Authorization: Bearer $secret" \
  -H 'Content-Type: application/json' -d '{"title":"live","live":true}' >/dev/null
echo "live: $base/v/$id/index.m3u8   (player: $base/?src=$base/v/$id/index.m3u8)"
exec ffmpeg -hide_banner -loglevel warning "${src[@]}" \
  -map 0:v -map 1:a? -map 0:a? \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 2675k -bufsize 3750k \
  -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p -vf scale=-2:720 \
  -c:a aac -b:a 160k -ac 2 -ar 48000 \
  -f hls -hls_time 2 -hls_list_size 6 -hls_segment_type fmp4 \
  -hls_flags delete_segments+independent_segments+program_date_time \
  -hls_fmp4_init_filename init.mp4 \
  -method PUT -http_persistent 1 -headers "Authorization: Bearer $secret"$'\r\n' \
  -hls_segment_filename "$base/admin/obj/$id/seg_%05d.m4s" \
  "$base/admin/obj/$id/index.m3u8"
