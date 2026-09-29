"use client";

import { createClient } from "@/lib/supabase/client";
import { accountUrl } from "@/lib/main-site";

export function LogoutLink() {
  async function handleLogout() {
    await createClient().auth.signOut();
    // Cross-origin (main site), not a route in this app -- can't use next/navigation for this.
    window.location.href = accountUrl();
  }
  return (
    <button onClick={handleLogout} className="text-text-dim underline hover:text-text">
      Log out
    </button>
  );
}
