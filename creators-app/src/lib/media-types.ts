// Single source of truth for what this platform accepts, shared by the upload API
// route (real enforcement) and the frontend (early feedback before a wasted upload).
// Matches the media-worker's TYPES map -- keep both in sync if this changes.

export type MediaKind = "image" | "audio" | "video";

export const MAX_SIZE_BYTES: Record<MediaKind, number> = {
  image: 15 * 1024 * 1024, // 15 MB
  audio: 50 * 1024 * 1024, // 50 MB
  video: 2 * 1024 * 1024 * 1024, // 2 GiB -- uploads go straight to R2 in 32 MiB parts, see lib/r2.ts
};

// Independent of each user's own 1 GiB quota (supabase/migrations/creator_media.sql):
// a hard ceiling on total storage across every account combined, so the R2 bill can
// never run away even if far more than the ~1000 users the per-user quota was sized
// around end up signing up.
export const SITE_STORAGE_CAP_BYTES = 1024 * 1024 * 1024 * 1024; // 1 TiB

// Magic-byte signatures checked server-side (see api/upload/request) -- never trust
// a client-declared extension or Content-Type alone.
export const ALLOWED_TYPES: Record<string, { kind: MediaKind; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "audio/mpeg": { kind: "audio", ext: "mp3" },
  "audio/ogg": { kind: "audio", ext: "ogg" },
  "audio/wav": { kind: "audio", ext: "wav" },
  "audio/x-wav": { kind: "audio", ext: "wav" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
};

export const ACCEPT_ATTR = Object.keys(ALLOWED_TYPES).join(",");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
