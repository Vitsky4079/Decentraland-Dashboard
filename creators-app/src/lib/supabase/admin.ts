import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client: bypasses RLS entirely. Only ever import this from Route
// Handlers (never a Client Component), and only after the request's own session
// (see lib/supabase/server.ts) has confirmed who the user is -- this client trusts
// whatever user_id you hand it, it doesn't check anything itself.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
