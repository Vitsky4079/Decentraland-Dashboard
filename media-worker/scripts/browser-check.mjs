#!/usr/bin/env node
// Headless Chromium check of the web-explorer playback path: hls.js + <video crossOrigin>
// + a frame read-back (fails on a CORS-tainted frame, like a WebGL texture upload would).
//   node scripts/browser-check.mjs <m3u8-or-mp4-url> [more urls…]
// Env: CHROMIUM (default: `chromium` on PATH or the nix store, like ~/one/rig/config.sh)
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const urls = process.argv.slice(2);
if (!urls.length) { console.error("usage: browser-check.mjs <url>…"); process.exit(1); }
const exe = process.env.CHROMIUM ||
  execSync("command -v chromium || ls -d /nix/store/*-chromium-[0-9]*/bin/chromium | head -1", { shell: "/bin/sh" }).toString().trim();
// Player page from the worker on `localhost`; media on 127.0.0.1 -> requests are cross-origin.
const playerOrigin = process.env.PLAYER_URL ?? "http://localhost:5250";

const browser = await chromium.launch({ executablePath: exe, args: ["--autoplay-policy=no-user-gesture-required"] });
let failed = 0;
for (const src of urls) {
  const page = await browser.newPage();
  await page.goto(`${playerOrigin}/?src=${encodeURIComponent(src)}`);
  let r;
  try {
    await page.waitForFunction(() => ["playing", "error"].includes(window.__result?.state), null, { timeout: 30000 });
    r = await page.evaluate(() => window.__result);
  } catch { r = { state: "timeout", last: await page.evaluate(() => window.__result) }; }
  const ok = r.state === "playing" && r.cors === "ok" && r.currentTime > 1;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${src}\n     ${JSON.stringify(r)}`);
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
