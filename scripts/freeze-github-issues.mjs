#!/usr/bin/env node
// Writes assets/data/github-issues.json: a frozen, already-processed copy of the GitHub issues
// the site shows, so the site can serve them as a static file instead of calling the Supabase
// edge function on every visit (that function returns ~1.8 MB per call and drove the egress overage).
//
// It reuses the site's own processing code from assets/dcl.js, so the snapshot matches live data.
// Refresh later by running:  node scripts/freeze-github-issues.mjs
// Resume live data by removing `snapshotUrl` from the `github` block in assets/config.js.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(root, 'assets/config.js'), 'utf8');
const dcl = readFileSync(join(root, 'assets/dcl.js'), 'utf8');

const url = config.match(/url:\s*'(https:\/\/[a-z0-9]+\.supabase\.co)'/)?.[1];
const key = config.match(/anonKey:\s*'([^']+)'/)?.[1];
if (!url || !key) throw new Error('Supabase url/anonKey not found in assets/config.js');

const areaFor = {};
for (const m of config.matchAll(/repo:\s*'([^']+)',\s*area:\s*'([^']+)'/g)) areaFor[m[1]] = m[2];

// Pull the site's helpers (cleanTitle .. summarize) and processIssue out of dcl.js, unchanged.
const slice = (from, to) => {
  const a = dcl.indexOf(from), b = dcl.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`could not find ${from} .. ${to} in assets/dcl.js`);
  return dcl.slice(a, b);
};
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  slice('function cleanTitle', 'function findWorkaround') + '\n' +
  slice('function processIssue', '// Try the Supabase edge function') +
  '\nthis.processIssue = processIssue;',
  sandbox,
);

console.log('fetching the live issue list once ...');
const res = await fetch(`${url}/functions/v1/github-issues`, {
  headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
});
if (!res.ok) throw new Error(`github-issues returned HTTP ${res.status}`);
const data = await res.json();
if (!Array.isArray(data.repos) || !data.repos.length) throw new Error('unexpected payload');

const repos = data.repos.map((r) => ({
  repo: r.repo,
  capped: !!r.capped,
  items: (r.items || []).map((it) => sandbox.processIssue(it, areaFor[r.repo] || 'Platform')).filter(Boolean),
}));
const out = { frozen: true, processed: true, syncedAt: Date.now(), partial: !!data.partial, repos };

const file = join(root, 'assets/data/github-issues.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out));
const total = repos.reduce((n, r) => n + r.items.length, 0);
console.log(`wrote ${file}: ${total} issues in ${repos.length} repos, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
