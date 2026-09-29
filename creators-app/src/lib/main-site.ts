// The main decentraland-dashboard.org site is the one place users log in/sign up --
// this app trusts the session cookie shared across .decentraland-dashboard.org (see
// lib/supabase/cookie-domain.ts) rather than having its own login form.
const MAIN_SITE_URL = process.env.NEXT_PUBLIC_MAIN_SITE_URL || "https://decentraland-dashboard.org";

export function accountUrl(): string {
  return `${MAIN_SITE_URL}/account`;
}
