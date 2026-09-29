"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ACCEPT_ATTR, formatBytes } from "@/lib/media-types";
import { accountUrl } from "@/lib/main-site";
import type { MediaFile } from "@/lib/types";
import { uploadFile } from "./upload";

type InFlight = { id: string; name: string; pct: number; error?: string };

export function Dashboard({
  email,
  initialFiles,
  quotaBytes,
  usedBytes,
}: {
  email: string;
  initialFiles: MediaFile[];
  quotaBytes: number;
  usedBytes: number;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [used, setUsed] = useState(usedBytes);
  const [inFlight, setInFlight] = useState<InFlight[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleLogout() {
    await createClient().auth.signOut();
    // Cross-origin (main site), not a route in this app -- can't use next/navigation for this.
    window.location.href = accountUrl();
  }

  function handleFiles(list: FileList | null) {
    if (!list) return;
    Array.from(list).forEach((file) => {
      const id = crypto.randomUUID();
      setInFlight((prev) => [...prev, { id, name: file.name, pct: 0 }]);
      uploadFile(file, (pct) => setInFlight((prev) => prev.map((f) => (f.id === id ? { ...f, pct } : f))))
        .then((record) => {
          setFiles((prev) => [record, ...prev]);
          setUsed((prev) => prev + record.size_bytes);
          setInFlight((prev) => prev.filter((f) => f.id !== id));
        })
        .catch((err: Error) => {
          setInFlight((prev) => prev.map((f) => (f.id === id ? { ...f, error: err.message } : f)));
        });
    });
  }

  async function handleDelete(file: MediaFile) {
    if (!confirm(`Delete "${file.original_name}"? This can't be undone.`)) return;
    const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("Could not delete this file.");
      return;
    }
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    setUsed((prev) => prev - file.size_bytes);
  }

  async function handleRename(file: MediaFile, newName: string) {
    setRenamingId(null);
    if (!newName || newName === file.original_name) return;
    const res = await fetch(`/api/files/${file.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ originalName: newName }),
    });
    if (!res.ok) {
      alert("Could not rename this file.");
      return;
    }
    const updated = (await res.json()) as MediaFile;
    setFiles((prev) => prev.map((f) => (f.id === file.id ? updated : f)));
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  const pct = quotaBytes > 0 ? Math.min(100, Math.round((used / quotaBytes) * 100)) : 0;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your Drive</h1>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-black/60 dark:text-white/60">{email}</span>
          <button onClick={handleLogout} className="underline">
            Log out
          </button>
        </div>
      </header>

      <section>
        <div className="mb-1 flex justify-between text-sm">
          <span>Storage used</span>
          <span>
            {formatBytes(used)} / {formatBytes(quotaBytes)}
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-black/10 dark:bg-white/10">
          <div className="h-2 rounded-full bg-foreground" style={{ width: `${pct}%` }} />
        </div>
      </section>

      <section
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-black/20 px-6 py-10 text-center text-sm text-black/60 hover:border-black/40 dark:border-white/20 dark:text-white/60 dark:hover:border-white/40"
      >
        <p>Drag a file here, or click to choose one.</p>
        <p className="text-xs">JPG, PNG, WebP, MP3, OGG, WAV, MP4, WebM</p>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </section>

      {inFlight.length > 0 && (
        <ul className="flex flex-col gap-2">
          {inFlight.map((f) => (
            <li key={f.id} className="text-sm">
              <div className="flex justify-between">
                <span className="truncate">{f.name}</span>
                <span>{f.error ? "failed" : `${f.pct}%`}</span>
              </div>
              {f.error ? (
                <p className="text-red-600">{f.error}</p>
              ) : (
                <div className="h-1 w-full rounded-full bg-black/10 dark:bg-white/10">
                  <div className="h-1 rounded-full bg-foreground" style={{ width: `${f.pct}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3">
        {files.length === 0 && <p className="text-sm text-black/60 dark:text-white/60">No files yet.</p>}
        {files.map((file) => (
          <div key={file.id} className="flex items-center gap-4 rounded border border-black/10 p-3 text-sm dark:border-white/10">
            <div className="min-w-0 flex-1">
              {renamingId === file.id ? (
                <input
                  autoFocus
                  defaultValue={file.original_name}
                  onBlur={(e) => handleRename(file, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="w-full rounded border border-black/20 px-2 py-1 dark:border-white/20"
                />
              ) : (
                <p className="truncate font-medium">{file.original_name}</p>
              )}
              <p className="text-xs text-black/50 dark:text-white/50">
                {file.kind} · {formatBytes(file.size_bytes)}
              </p>
              <p className="truncate text-xs text-black/40 dark:text-white/40">{file.url}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button onClick={() => copyUrl(file.url)} className="rounded border border-black/15 px-2 py-1 dark:border-white/20">
                Copy URL
              </button>
              <button onClick={() => setRenamingId(file.id)} className="rounded border border-black/15 px-2 py-1 dark:border-white/20">
                Rename
              </button>
              <button onClick={() => handleDelete(file)} className="rounded border border-red-300 px-2 py-1 text-red-600">
                Delete
              </button>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
