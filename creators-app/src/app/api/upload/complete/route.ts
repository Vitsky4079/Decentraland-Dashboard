import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MediaKind } from "@/lib/media-types";

// Step 2: the client has already PUT the file straight to the media worker using the
// token from /api/upload/request. This route doesn't trust anything the client says
// about the result -- it HEADs the worker's public URL itself to get the real,
// authoritative Content-Type/size R2 actually stored, then writes the DB row.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { key, originalName } = (await req.json()) as { key?: string; originalName?: string };
  if (!key || !originalName) return NextResponse.json({ error: "key and originalName are required" }, { status: 400 });

  // A key is "<user_id>/<uuid>.<ext>" -- refuse to record anything outside the
  // caller's own prefix, even though only this same request route ever mints one.
  if (!key.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "key does not belong to this user" }, { status: 403 });
  }

  const publicUrl = `${process.env.MEDIA_WORKER_URL}/v/${key}`;
  const head = await fetch(publicUrl, { method: "HEAD" });
  if (!head.ok) {
    return NextResponse.json({ error: "upload did not complete" }, { status: 409 });
  }
  const mimeType = head.headers.get("Content-Type") ?? "application/octet-stream";
  const sizeBytes = Number(head.headers.get("Content-Length") ?? 0);
  const kind: MediaKind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "video";

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("media_files")
    .insert({
      user_id: user.id,
      storage_key: key,
      original_name: originalName.slice(0, 200),
      mime_type: mimeType,
      kind,
      size_bytes: sizeBytes,
      url: publicUrl,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
