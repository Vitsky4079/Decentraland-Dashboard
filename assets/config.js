/* =========================================================
   DASHBOARD CONFIG — this is the only file you normally edit
   ========================================================= */

const DCL_CONFIG = {

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

  // Manual overrides during verified incidents, e.g.:
  // statusOverrides: { 'Worlds': 'Partial Outage', 'Events': 'Degraded' }
  // Valid values: 'Operational' | 'Degraded' | 'Partial Outage' | 'Outage'
  statusOverrides: {},

  recentFixDays: 45,     // window for the "Recently fixed" page
  pageSize: 12,          // cards per "Show more" step on list pages
  cacheMinutes: 15,      // how long fetched GitHub data is reused across pages
};
