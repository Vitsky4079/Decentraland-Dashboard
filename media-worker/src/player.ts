// Test player. Mirrors what the web explorer does (engine/web/src/engine.ts):
// <video crossOrigin="anonymous"> + hls.js, then a texture upload. The canvas
// drawImage/getImageData step fails if CORS is wrong, same as a WebGL upload would.
export const PLAYER_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dcl-media-r2 player</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --mute:#666; --line:#ddd; --ok:#0a7d32; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --mute:#999; --line:#333; --ok:#4ade80; --bad:#f87171; } }
  body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; margin:0 auto; max-width:900px; padding:16px; }
  h1 { font-size:18px; margin:0 0 12px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  input { flex:1 1 320px; min-width:0; padding:6px 8px; font:inherit; }
  button { padding:6px 12px; font:inherit; cursor:pointer; }
  video { width:100%; background:#000; aspect-ratio:16/9; }
  ul { padding-left:18px; } li a { cursor:pointer; text-decoration:underline; }
  pre { border:1px solid var(--line); padding:8px; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .mute { color:var(--mute); }
</style>
</head>
<body>
<h1>dcl-media-r2 test player</h1>
<div class="row"><input id="src" placeholder="https://…/master.m3u8"><button id="go">Play</button></div>
<video id="v" controls muted playsinline crossorigin="anonymous"></video>
<pre id="status" class="mute">idle</pre>
<h2 style="font-size:15px">Videos in bucket</h2>
<ul id="list"><li class="mute">loading…</li></ul>
<script>
const v = document.getElementById('v'), st = document.getElementById('status'), srcIn = document.getElementById('src');
window.__result = { state: 'idle' };
let hls;
function log(msg, cls) { st.textContent = msg; st.className = cls || ''; }
function play(src) {
  srcIn.value = src; if (hls) { hls.destroy(); hls = null; }
  window.__result = { state: 'loading', src };
  if (/\\.m3u8(\\?|#|$)/i.test(src) && window.Hls && Hls.isSupported()) {
    hls = new Hls(); hls.loadSource(src); hls.attachMedia(v);
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { window.__result = { state: 'error', detail: d.details }; log('hls error: ' + d.details, 'bad'); } });
    hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => log('manifest: ' + d.levels.map(l => l.height + 'p').join(', ')));
  } else { v.src = src; }
  v.play().catch(() => {});
}
v.addEventListener('error', () => { window.__result = { state: 'error', detail: String(v.error && v.error.message) }; log('video error', 'bad'); });
v.addEventListener('timeupdate', () => {
  if (v.currentTime < 1.5 || window.__result.state === 'playing') return;
  // Texture-upload check: throws SecurityError on a tainted (non-CORS) frame.
  let cors = 'ok';
  try { const c = document.createElement('canvas'); c.width = 16; c.height = 9;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0, 16, 9); g.getImageData(0, 0, 1, 1); }
  catch (e) { cors = 'tainted: ' + e.name; }
  const level = hls && hls.levels[hls.currentLevel];
  window.__result = { state: 'playing', currentTime: v.currentTime, width: v.videoWidth, height: v.videoHeight,
                      level: level ? level.height : null, cors };
  log(JSON.stringify(window.__result, null, 1), cors === 'ok' ? 'ok' : 'bad');
});
document.getElementById('go').onclick = () => play(srcIn.value);
fetch('/api/videos').then(r => r.json()).then(vs => {
  const ul = document.getElementById('list'); ul.innerHTML = '';
  if (!vs.length) ul.innerHTML = '<li class="mute">empty — run scripts/transcode.sh</li>';
  for (const x of vs) {
    const li = document.createElement('li');
    if (x.private) { li.textContent = x.id + ' (private — mint a token)'; }
    else { const a = document.createElement('a'); a.textContent = x.id; a.onclick = () => play(location.origin + '/v/' + x.id + '/master.m3u8'); li.append(a); }
    ul.append(li);
  }
});
const q = new URLSearchParams(location.search).get('src'); if (q) play(q);
</script>
</body>
</html>`;
