import { NextResponse } from "next/server";
import { CompleteMultipartUploadCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MAX_SIZE_BYTES, SITE_STORAGE_CAP_BYTES, type MediaKind } from "@/lib/media-types";
import { R2_BUCKET, r2Client } from "@/lib/r2";

// Step 2: the client has uploaded every part straight to R2 using the presigned URLs
// from /api/upload/request. This route stitches the parts into one object, then
// doesn't trust anything the client says about the result -- it HEADs the object in R2
// for the real, authoritative size/Content-Type, re-checks quota against that, and only
// then writes the DB row.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { key, uploadId, parts, originalName } = (await req.json()) as {
    key?: string;
    uploadId?: string;
    parts?: { partNumber: number; etag: string }[];
    originalName?: string;
  };
  if (!key || !uploadId || !originalName || !Array.isArray(parts) || parts.length === 0) {
    return NextResponse.json({ error: "key, uploadId, parts and originalName are required" }, { status: 400 });
  }

  // A key is "<user_id>/<uuid>.<ext>" -- refuse to record anything outside the
  // caller's own prefix, even though only the request route ever mints one.
  if (!key.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "key does not belong to this user" }, { status: 403 });
  }

  const r2 = r2Client();
  try {
    await r2.send(
      new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  } catch {
    return NextResponse.json({ error: "upload did not complete" }, { status: 409 });
  }

  let sizeBytes: number;
  let mimeType: string;
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    sizeBytes = head.ContentLength ?? 0;
    mimeType = head.ContentType ?? "application/octet-stream";
  } catch {
    return NextResponse.json({ error: "upload did not complete" }, { status: 409 });
  }
  const kind: MediaKind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "video";

  const admin = createAdminClient();
  const [{ data: profile }, { data: usedBytes }, { data: totalUsedBytes }] = await Promise.all([
    admin.from("user_profiles").select("quota_bytes").eq("id", user.id).single(),
    admin.rpc("get_storage_usage", { p_user_id: user.id }),
    admin.rpc("get_total_storage_usage"),
  ]);
  const used = typeof usedBytes === "number" ? usedBytes : Number(usedBytes ?? 0);
  const totalUsed = typeof totalUsedBytes === "number" ? totalUsedBytes : Number(totalUsedBytes ?? 0);

  const rejection =
    sizeBytes <= 0 || sizeBytes > MAX_SIZE_BYTES[kind]
      ? "file size is not allowed"
      : used + sizeBytes > (profile?.quota_bytes ?? 0)
        ? "storage quota exceeded"
        : totalUsed + sizeBytes > SITE_STORAGE_CAP_BYTES
          ? "Drive has reached its total storage limit -- please try again later"
          : null;
  if (rejection) {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {});
    return NextResponse.json({ error: rejection }, { status: 413 });
  }

  const publicUrl = `${process.env.MEDIA_WORKER_URL}/v/${key}`;
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
