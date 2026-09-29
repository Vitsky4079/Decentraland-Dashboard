#!/usr/bin/env node
// Push out/<id>/ into R2 through the Worker's admin API.
//   node scripts/upload.mjs <id> [--private] [--title "…"]
// Env: MEDIA_URL (default http://127.0.0.1:5250), ADMIN_SECRET (default from .dev.vars)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const id = args[0];
if (!id) { console.error("usage: upload.mjs <id> [--private] [--title T]"); process.exit(1); }
const priv = args.includes("--private");
const ti = args.indexOf("--title");
const title = ti >= 0 ? args[ti + 1] : id;

const base = process.env.MEDIA_URL ?? "http://127.0.0.1:5250";
const secret = process.env.ADMIN_SECRET ??
  readFileSync(".dev.vars", "utf8").match(/^ADMIN_SECRET=(.*)$/m)?.[1];
const auth = { Authorization: `Bearer ${secret}` };

const dir = join("out", id);
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(dir);

let bytes = 0;
const queue = [...files];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let f; (f = queue.shift()); ) {
    const key = `${id}/${relative(dir, f)}`;
    const body = readFileSync(f);
    const r = await fetch(`${base}/admin/obj/${key}`, { method: "PUT", headers: auth, body });
    if (!r.ok) throw new Error(`${key}: ${r.status} ${await r.text()}`);
    bytes += body.length;
  }
}));
const m = await fetch(`${base}/admin/meta/${id}`, {
  method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ private: priv, title }),
});
if (!m.ok) throw new Error(`meta: ${m.status}`);
console.log(`uploaded ${files.length} files (${(bytes / 1e6).toFixed(1)} MB) as ${priv ? "private" : "public"} "${id}"`);
if (priv) console.log(`mint a token: scripts/token.sh ${id}`);
else console.log(`play: ${base}/v/${id}/master.m3u8\n      ${base}/?src=${base}/v/${id}/master.m3u8`);
