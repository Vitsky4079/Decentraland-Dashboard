import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { COOKIE_DOMAIN, AUTH_STORAGE_KEY } from "./cookie-domain";

// Server-side Supabase client for Server Components / Route Handlers, bound to the
// current request's auth cookies. Still just the anon key + RLS -- use
// lib/supabase/admin.ts instead when a route needs to bypass RLS on purpose
// (writing media_files rows, deleting a user's own R2 object, etc).
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { domain: COOKIE_DOMAIN },
      auth: { storageKey: AUTH_STORAGE_KEY },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component that can't set cookies -- fine as long
            // as proxy.ts is refreshing the session on every request.
          }
        },
      },
    },
  );
}
