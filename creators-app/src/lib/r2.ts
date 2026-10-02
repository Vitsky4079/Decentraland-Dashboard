import { S3Client } from "@aws-sdk/client-s3";

// 32 MiB parts: well above R2's 5 MiB minimum, small enough that a dropped
// connection only costs one part, and 2 GiB of video is just 64 parts.
export const PART_SIZE = 32 * 1024 * 1024;
export const PART_URL_TTL_SECONDS = 12 * 60 * 60; // a 5 GiB file on a slow connection can take hours

export const R2_BUCKET = process.env.R2_BUCKET || "dcl-media";

let client: S3Client | null = null;

// Server-only: talks to R2's S3-compatible endpoint with an R2 API token, so the
// browser can upload straight to R2 and never pass through the media worker (whose
// request-body and memory limits are what capped uploads before).
export function r2Client(): S3Client {
  if (!client) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set");
    }
    client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}
