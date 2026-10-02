import { NextResponse } from "next/server";
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { createClient } from "@/lib/supabase/server";
import { R2_BUCKET, r2Client } from "@/lib/r2";

// Best-effort cleanup when an upload fails partway: frees the parts already stored in
// R2 right away instead of waiting for the bucket's abandoned-upload lifecycle rule.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { key, uploadId } = (await req.json()) as { key?: string; uploadId?: string };
  if (!key || !uploadId || !key.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await r2Client()
    .send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId }))
    .catch(() => {});
  return NextResponse.json({ ok: true });
}
