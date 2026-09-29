import type { MediaFile } from "@/lib/types";

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

function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

// Full client-side upload flow: sample the file for the server to sniff/validate,
// get a scoped one-object upload URL, PUT the actual bytes straight to the media
// worker (never through this app's own server), then confirm.
//
// Progress is staged (0-8% sampling/request, 8-92% the real PUT, 92-100% finalizing)
// rather than just forwarding the PUT's raw byte progress -- for small files (most
// images) the PUT itself finishes in well under a second, so without these stages
// the bar visually jumped straight from 0% to 100% with nothing shown for the two
// network round-trips around it.
export async function uploadFile(file: File, onProgress: (pct: number) => void): Promise<MediaFile> {
  onProgress(3);
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
  const { uploadUrl, key } = (await reqRes.json()) as { uploadUrl: string; key: string };

  await putWithProgress(uploadUrl, file, (pct) => onProgress(8 + Math.round(pct * 0.84)));

  onProgress(92);
  const completeRes = await fetch("/api/upload/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, originalName: file.name }),
  });
  if (!completeRes.ok) {
    const { error } = await completeRes.json().catch(() => ({ error: "could not finalize upload" }));
    throw new Error(error ?? "could not finalize upload");
  }
  onProgress(100);
  return (await completeRes.json()) as MediaFile;
}
