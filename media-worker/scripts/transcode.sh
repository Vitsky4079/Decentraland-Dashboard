#!/usr/bin/env bash
# Transcode a file into an HLS fMP4 ladder that fits Decentraland's VideoPlayer limits
# (720p max, ~2.5 Mbps, AAC 160k, 30 fps) plus a faststart MP4 fallback.
#   scripts/transcode.sh <input|--test> <video-id>      -> out/<video-id>/
# --test synthesizes a 30 s clip (test pattern + running clock + tone), no download needed.
set -euo pipefail
in=${1:?input file or --test}; id=${2:?video id}
[[ $id =~ ^[A-Za-z0-9_-]+$ ]] || { echo "id must match [A-Za-z0-9_-]+"; exit 1; }
out=out/$id; rm -rf "$out"; mkdir -p "$out"

if [[ $in == --test ]]; then
  src=(-f lavfi -i "testsrc2=size=1280x720:rate=30:duration=30" -f lavfi -i "sine=frequency=440:duration=30")
else
  src=(-i "$in")
fi

# Two renditions sharing one audio track; 4 s segments aligned to keyframes (GOP 120 @ 30 fps).
ffmpeg -hide_banner -loglevel warning -y "${src[@]}" \
  -filter_complex "[0:v]fps=30,split=2[a][b];[a]scale=-2:720[v720];[b]scale=-2:480[v480]" \
  -map "[v720]" -map "[v480]" -map 1:a? -map 0:a? \
  -c:v libx264 -profile:v main -preset veryfast -g 120 -keyint_min 120 -sc_threshold 0 -pix_fmt yuv420p \
  -b:v:0 2500k -maxrate:v:0 2675k -bufsize:v:0 3750k \
  -b:v:1 1000k -maxrate:v:1 1070k -bufsize:v:1 1500k \
  -c:a aac -b:a 160k -ac 2 -ar 48000 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_flags independent_segments \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,agroup:aud,name:720p v:1,agroup:aud,name:480p a:0,agroup:aud,name:audio,default:yes" \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$out/%v/seg_%03d.m4s" "$out/%v/index.m3u8"

# Progressive MP4 (moov up front so playback starts on the first Range request).
ffmpeg -hide_banner -loglevel warning -y "${src[@]}" -map 0:v -map 1:a? -map 0:a? \
  -vf "fps=30,scale=-2:720" -c:v libx264 -preset veryfast -b:v 2500k -pix_fmt yuv420p \
  -c:a aac -b:a 160k -movflags +faststart "$out/video.mp4"

echo "wrote $out:"; (cd "$out" && find . -type f | sort | head -8; echo "… $(find . -type f | wc -l) files, $(du -sh --apparent-size . | cut -f1)")
