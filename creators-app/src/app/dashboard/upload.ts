import type { MediaFile } from "@/lib/types";
import { ensureFaststart } from "@/lib/faststart";

const PART_CONCURRENCY = 4;
const PART_ATTEMPTS = 4;

function readSampleBase64(file: File, bytes = 32): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      resolve(btoa(String.fromCharCode(...buf)));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file.slice(0, bytes));
  });
}

// PUTs one part straight to R2 and resolves with the ETag R2 returns for it (the
// bucket's CORS rule must expose the ETag header, or the browser hides it).
function putPart(url: string, blob: Blob, onBytes: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(`upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(blob);
  });
}

async function putPartWithRetry(url: string, blob: Blob, onBytes: (loaded: number) => void): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
    try {
      return await putPart(url, blob, onBytes);
    } catch (err) {
      lastError = err;
      onBytes(0);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("upload failed");
}

// Full client-side upload flow: sample the file for the server to sniff/validate, get a
// presigned URL per part, upload the parts straight to R2 (a few at a time, each retried
// on its own -- never through this app's own server), then stitch them together.
//
// Progress is staged (0-8% sampling/request, 8-92% the real upload, 92-100% finalizing)
// rather than just forwarding raw byte progress -- for small files (most images) the
// upload itself finishes in well under a second, so without these stages the bar
// visually jumped straight from 0% to 100% with nothing shown for the network
// round-trips around it.
export async function uploadFile(selectedFile: File, onProgress: (pct: number) => void): Promise<MediaFile> {
  onProgress(3);
  // MP4/MOV files with the index at the end stall in the Explorer's video player; move it to
  // the front (lossless, no re-encode, no extra upload time). Other files pass through as-is.
  const file = await ensureFaststart(selectedFile);
  const sampleBase64 = await readSampleBase64(file);

  onProgress(8);
  const reqRes = await fetch("/api/upload/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, size: file.size, sampleBase64 }),
  });
  if (!reqRes.ok) {
    const { error } = await reqRes.json().catch(() => ({ error: "upload rejected" }));
    throw new Error(error ?? "upload rejected");
  }
  const { key, uploadId, partSize, parts } = (await reqRes.json()) as {
    key: string;
    uploadId: string;
    partSize: number;
    parts: { partNumber: number; url: string }[];
  };

  const loadedPerPart = new Array<number>(parts.length).fill(0);
  const reportBytes = () => {
    const loaded = loadedPerPart.reduce((a, b) => a + b, 0);
    onProgress(8 + Math.round((loaded / file.size) * 84));
  };

  const etags = new Array<string>(parts.length);
  let next = 0;
  let failed = false;
  try {
    await Promise.all(
      Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, async () => {
        while (next < parts.length && !failed) {
          const i = next++;
          const blob = file.slice(i * partSize, (i + 1) * partSize);
          etags[i] = await putPartWithRetry(parts[i].url, blob, (loaded) => {
            loadedPerPart[i] = loaded;
            reportBytes();
          });
          loadedPerPart[i] = blob.size;
          reportBytes();
        }
      }),
    );
  } catch (err) {
    failed = true;
    fetch("/api/upload/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, uploadId }),
    }).catch(() => {});
    throw err;
  }

  onProgress(92);
  const completeRes = await fetch("/api/upload/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      uploadId,
      originalName: file.name,
      parts: parts.map((p, i) => ({ partNumber: p.partNumber, etag: etags[i] })),
    }),
  });
  if (!completeRes.ok) {
    const { error } = await completeRes.json().catch(() => ({ error: "could not finalize upload" }));
    throw new Error(error ?? "could not finalize upload");
  }
  onProgress(100);
  return (await completeRes.json()) as MediaFile;
}
