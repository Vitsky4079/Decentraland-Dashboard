/* =========================================================
   DASHBOARD CONFIG — this is the only file you normally edit
   ========================================================= */

const DCL_CONFIG = {

  // Supabase project (Database + Admin login). Get both values from
  // Supabase → Project Settings → API. The anon key is safe to publish —
  // Row Level Security restricts writes to logged-in admins only.
  // GitHub data source. When useProxy is true, issues are fetched through the
  // Supabase edge function 'github-issues' (server-side token, shared 10-min
  // cache, 5000 req/hour) instead of directly from the browser (60/hour limit).
  // If the function isn't deployed or fails, the site automatically falls back
  // to direct GitHub fetching, so this is safe to leave on.
  github: {
    useProxy: true,
  },

  supabase: {
    url: 'https://bkedlefssfcyashgxxqg.supabase.co',
    // "Publishable key" (sb_publishable_...) — safe to ship in public code by design;
    // Row Level Security restricts all writes to logged-in admins.
    // NEVER put the secret key (sb_secret_...) here or anywhere in this repo.
    anonKey: 'sb_publishable_777eM-cG5uMIqzGOh-LRSg_IKSim8hB',
  },

  // GitHub repos to track. `area` is the user-facing label,
  // `reportAs` is the wording in the Report page dropdowns.
  repos: [
    { repo: 'decentraland/unity-explorer', area: 'Explorer',    reportAs: 'the Explorer (desktop app / in-world)' },
    { repo: 'decentraland/creator-hub',    area: 'Creator Hub', reportAs: 'the Creator Hub' },
    { repo: 'decentraland/builder',        area: 'Builder',     reportAs: 'the Builder / Marketplace tools' },
    { repo: 'decentraland/sdk',            area: 'SDK',         reportAs: 'the SDK (scene development)' },
    { repo: 'decentraland/core-team',      area: 'Platform',    reportAs: 'something else / general platform' },
  ],

  // Services shown on the status board. Status is derived from
  // matching open issues (by repo area or title keywords).
  services: [
    { name: 'Explorer',       desc: 'Desktop client & in-world experience', keys: ['explorer','client','avatar','render','crash','world loading'], repoAreas: ['Explorer'] },
    { name: 'Creator Hub',    desc: 'Scene creation desktop app',           keys: ['creator hub'], repoAreas: ['Creator Hub'] },
    { name: 'Worlds',         desc: 'Personal worlds & hosting',            keys: ['worlds','world '], repoAreas: [] },
    { name: 'Marketplace',    desc: 'Wearables, names & LAND trading',      keys: ['marketplace','wearable','collection','listing'], repoAreas: ['Builder'] },
    { name: 'Events',         desc: 'Event listings & calendar',            keys: ['events','event page','calendar'], repoAreas: [] },
    { name: 'Login & Wallet', desc: 'Sign-in, wallets & transactions',      keys: ['login','sign in','sign-in','wallet','auth','transaction'], repoAreas: [] },
    { name: 'Social',         desc: 'Friends, chat & communities',          keys: ['friend','chat','social','community','voice'], repoAreas: [] },
  ],

  // Official status page integration.
  // `pageUrl` is always linked in the UI. If the official page exposes a JSON
  // API (open status.decentraland.org with DevTools → Network and look for a
  // JSON request), paste it into `summaryUrl` and official component statuses
  // will override the GitHub-derived ones. Statuspage-style format expected:
  //   { components:[{name,status}], incidents:[{name,status,impact,shortlink}] }
  officialStatus: {
    pageUrl: 'https://status.decentraland.org/',
    summaryUrl: '',          // e.g. 'https://status.decentraland.org/api/v2/summary.json'
    // official component name (lowercase) -> service name on this dashboard
    componentMap: {
      'explorer': 'Explorer', 'desktop client': 'Explorer',
      'creator hub': 'Creator Hub',
      'worlds': 'Worlds',
      'marketplace': 'Marketplace', 'builder': 'Marketplace',
      'events': 'Events',
      'authentication': 'Login & Wallet', 'login': 'Login & Wallet', 'wallet': 'Login & Wallet',
      'social': 'Social', 'social service': 'Social', 'chat': 'Social',
    },
  },

  // Manual site-wide announcement banner. Leave text empty to hide.
  // level: 'Info' | 'Degraded' | 'Partial Outage' | 'Outage'
  announcement: {
    text: '',                // e.g. 'Marketplace maintenance tonight 20:00–21:00 CET.'
    level: 'Info',
    link: '',                // optional "More details" URL
  },

  // Derive service status from open GitHub issues?
  // false (recommended): services always show Operational unless the official
  //   status page or a manual override says otherwise. Open bugs never turn
  //   a service yellow/red — a crash report is not an outage.
  // true: issues with an explicit critical/blocker/P0 label can mark a
  //   service Degraded (1+) or Partial Outage (3+).
  deriveServiceStatus: false,

  // Manual overrides during verified incidents, e.g.:
  // statusOverrides: { 'Worlds': 'Partial Outage', 'Events': 'Degraded' }
  // Valid values: 'Operational' | 'Degraded' | 'Partial Outage' | 'Outage'
  statusOverrides: {},

  // Admin panel (admin.html). The passphrase only hides the panel UI — real
  // write access requires a GitHub token entered at save time (never stored).
  // To change the passphrase: open admin.html, use the hash generator at the
  // bottom of the login box, and paste the new hash here.
  admin: {
    passHash: '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', // default passphrase: admin
    // Admin-to-admin notes are visible to every logged-in admin but the editor
    // is shown only to this account email (UI gate). Set to your Supabase Auth
    // login email. Leave '' to let any admin edit. Case-insensitive.
    ownerEmail: '',
  },

  // Issues pinned to "Top known issues" on the overview (GitHub issue URLs,
  // shown first, in this order). Manage them easily from admin.html.
  pinnedIssues: [],

  // Per-issue editorial overrides, keyed by GitHub issue URL. Managed from
  // admin.html. Each entry may set any of:
  //   title, summary, status, impact, area, workaround (strings)
  //   hidden (true to remove from the public dashboard)
  // Anything omitted falls back to the value derived from GitHub.
  issueOverrides: {},

  // Patch notes shown on the overview. Newest first. Each entry:
  //   { version, date, body }  — body is the raw text you paste (markdown-ish).
  patchNotes: [],

  // Where the "Report a bug" / "Request a feature" buttons send people.
  // Uses GitHub issue templates so the form matches the repo's QA workflow.
  reporting: {
    primaryRepo: 'decentraland/unity-explorer',
    bugTemplate: 'bug_report.md',          // pre-fills the QA bug form + labels
    featureTemplate: 'feature_request.md',  // pre-fills the feature form + 'suggestion' label
  },

  // Asset bundle conversion queue (read-only). Mirrors deployments.lastslice.co:
  // reads pending jobs from a registry/queue endpoint and resolves entity IDs to
  // scene names + parcels via the catalyst content server. No write access and
  // no secret token — submitting jobs stays on the infra side.
  //
  // The registry is public (no auth) and CORS-open. /queues/status returns
  // { webglPendingJobs: [cid...], windowsPendingJobs: [...], macPendingJobs: [...] }.
  assetBundles: {
    enabled: true,
    // Confirmed public, no-auth endpoint (returns {webglPendingJobs:[],windowsPendingJobs:[],macPendingJobs:[]})
    queueUrl: 'https://asset-bundle-registry.decentraland.org/queues/status',
    // Base for per-entity lookups: GET {registryUrl}/entities/status/{entityCID}
    registryUrl: 'https://asset-bundle-registry.decentraland.org',
    contentServer: 'https://peer.decentraland.org/content',
    worldsServer: 'https://worlds-content-server.decentraland.org',
    platforms: ['webgl', 'windows', 'mac'],
    refreshSeconds: 60,
    pageSize: 20,        // rows shown per "Load more" click
    resolvePool: 150,    // how many entities to resolve+sort for the recent view
    maxRowsPerPlatform: 25,
  },

  recentFixDays: 45,     // window for the "Recently fixed" page
  pageSize: 12,          // cards per "Show more" step on list pages
  cacheMinutes: 15,      // how long fetched GitHub data is reused across pages
};
