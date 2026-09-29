import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { accountUrl } from "@/lib/main-site";
import { Dashboard } from "./dashboard-client";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(accountUrl());

  const [{ data: files }, { data: profile }, { data: usedBytes }] = await Promise.all([
    supabase.from("media_files").select("*").order("created_at", { ascending: false }),
    supabase.from("user_profiles").select("quota_bytes").eq("id", user.id).single(),
    supabase.rpc("get_storage_usage", { p_user_id: user.id }),
  ]);

  return (
    <Dashboard
      email={user.email ?? ""}
      initialFiles={files ?? []}
      quotaBytes={profile?.quota_bytes ?? 0}
      usedBytes={Number(usedBytes ?? 0)}
    />
  );
}
