// For SSO across the main site and drive.decentraland-dashboard.org, the session
// cookie needs `Domain=.decentraland-dashboard.org` so both subdomains can read it.
// A browser rejects that Domain attribute outright on any host that isn't (a subdomain
// of) decentraland-dashboard.org -- localhost and Vercel preview deployments included --
// so this is an explicit opt-in env var, not inferred from NODE_ENV (which Vercel also
// sets to "production" for preview builds, which would otherwise silently break them).
// Leave NEXT_PUBLIC_COOKIE_DOMAIN unset for local dev and previews; set it to
// ".decentraland-dashboard.org" only on the real production deployment.
export const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || undefined;

// Must exactly match assets/auth.js's storageKey on the main site -- this is what
// the shared session cookie is actually named. If these two ever drift apart, SSO
// silently breaks (each side would just see its own session as "logged out"),
// rather than throwing an obvious error, so keep them in sync deliberately.
export const AUTH_STORAGE_KEY = "sb-decentraland-account";
