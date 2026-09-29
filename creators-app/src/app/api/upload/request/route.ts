import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ALLOWED_TYPES, MAX_SIZE_BYTES, SITE_STORAGE_CAP_BYTES } from "@/lib/media-types";
import { sniffMime } from "@/lib/sniff-mime";

// Step 1 of the upload flow: the client sends metadata + a small byte sample (not
// the whole file -- videos can be hundreds of MB, and this route runs on Vercel,
// which has request-size limits the actual upload deliberately avoids). This route
// decides whether the upload is allowed at all, then mints a short-lived, one-object
// upload token from the media worker. The actual file bytes go straight from the
// browser to the worker next, never through this server.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json()) as { fileName?: string; size?: number; sampleBase64?: string };
  const { fileName, size, sampleBase64 } = body;
  if (!fileName || !size || !sampleBase64) {
    return NextResponse.json({ error: "fileName, size and sampleBase64 are required" }, { status: 400 });
  }

  const sample = Buffer.from(sampleBase64, "base64");
  const sniffed = sniffMime(new Uint8Array(sample));
  const match = sniffed ? ALLOWED_TYPES[sniffed] : undefined;
  if (!match) {
    return NextResponse.json({ error: "unsupported or unrecognized file type" }, { status: 415 });
  }

  const maxSize = MAX_SIZE_BYTES[match.kind];
  if (size > maxSize) {
    return NextResponse.json({ error: `${match.kind} files are limited to ${Math.round(maxSize / 1024 / 1024)} MB` }, { status: 413 });
  }

  const admin = createAdminClient();
  const [{ data: profile }, { data: usedBytes }, { data: totalUsedBytes }, { count: recentUploads }] = await Promise.all([
    admin.from("user_profiles").select("quota_bytes").eq("id", user.id).single(),
    admin.rpc("get_storage_usage", { p_user_id: user.id }),
    admin.rpc("get_total_storage_usage"),
    admin
      .from("media_files")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gt("created_at", new Date(Date.now() - 60_000).toISOString()),
  ]);

  // Per-user rate limit: no new infra needed for this scale, just reuses the table
  // that already exists -- reject a burst rather than tracking it in memory/Redis,
  // since Vercel functions don't share memory across invocations anyway.
  if ((recentUploads ?? 0) >= 10) {
    return NextResponse.json({ error: "too many uploads, slow down and try again in a minute" }, { status: 429 });
  }

  const quotaBytes = profile?.quota_bytes ?? 0;
  const used = typeof usedBytes === "number" ? usedBytes : Number(usedBytes ?? 0);
  if (used + size > quotaBytes) {
    return NextResponse.json({ error: "storage quota exceeded" }, { status: 413 });
  }

  // Independent of the per-user quota above: a hard site-wide ceiling so total R2
  // usage can't run away regardless of how many accounts exist.
  const totalUsed = typeof totalUsedBytes === "number" ? totalUsedBytes : Number(totalUsedBytes ?? 0);
  if (totalUsed + size > SITE_STORAGE_CAP_BYTES) {
    return NextResponse.json({ error: "Drive has reached its total storage limit -- please try again later" }, { status: 413 });
  }

  const key = `${user.id}/${randomUUID()}.${match.ext}`;
  const workerRes = await fetch(`${process.env.MEDIA_WORKER_URL}/admin/upload-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.MEDIA_WORKER_ADMIN_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, maxSize, ttl: 600 }),
  });
  if (!workerRes.ok) {
    return NextResponse.json({ error: "could not prepare upload" }, { status: 502 });
  }
  const { url: uploadUrl } = (await workerRes.json()) as { url: string };

  return NextResponse.json({
    uploadUrl,
    key,
    kind: match.kind,
    mimeType: sniffed,
    publicUrl: `${process.env.MEDIA_WORKER_URL}/v/${key}`,
  });
}
