import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { accountUrl } from "@/lib/main-site";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(accountUrl());
  redirect("/dashboard");
}
