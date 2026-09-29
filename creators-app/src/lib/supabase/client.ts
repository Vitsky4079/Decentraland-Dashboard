import { createBrowserClient } from "@supabase/ssr";
import { COOKIE_DOMAIN, AUTH_STORAGE_KEY } from "./cookie-domain";

// Browser-side Supabase client, used from Client Components. Only ever holds the
// anon key -- RLS (see supabase/migrations/creator_media.sql) is what keeps a user
// scoped to their own rows, not this client's permissions.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: { domain: COOKIE_DOMAIN }, auth: { storageKey: AUTH_STORAGE_KEY } },
  );
}
