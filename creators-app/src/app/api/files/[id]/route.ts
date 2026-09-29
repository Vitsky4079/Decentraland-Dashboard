import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { originalName } = (await req.json()) as { originalName?: string };
  if (!originalName) return NextResponse.json({ error: "originalName is required" }, { status: 400 });

  const admin = createAdminClient();
  // Ownership is enforced in code here (admin client bypasses RLS), not by the DB.
  const { data, error } = await admin
    .from("media_files")
    .update({ original_name: originalName.slice(0, 200) })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const admin = createAdminClient();
  const { data: file, error: findError } = await admin
    .from("media_files")
    .select("id, storage_key")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (findError || !file) return NextResponse.json({ error: "not found" }, { status: 404 });

  const workerRes = await fetch(`${process.env.MEDIA_WORKER_URL}/admin/obj/${encodeURIComponent(file.storage_key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.MEDIA_WORKER_ADMIN_SECRET}` },
  });
  if (!workerRes.ok) return NextResponse.json({ error: "could not delete from storage" }, { status: 502 });

  const { error: deleteError } = await admin.from("media_files").delete().eq("id", id).eq("user_id", user.id);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
