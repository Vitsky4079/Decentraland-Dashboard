"use client";

import { useRef, useState } from "react";
import { ACCEPT_ATTR, formatBytes } from "@/lib/media-types";
import type { MediaFile } from "@/lib/types";
import { SiteHeader } from "@/components/site-header";
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
    <>
      <SiteHeader email={email} />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10">
        <h1 className="text-2xl font-bold">Your Drive</h1>

        <section>
          <div className="mb-1 flex justify-between text-sm">
            <span>Storage used</span>
            <span className="text-text-dim">
              {formatBytes(used)} / {formatBytes(quotaBytes)}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-surface-2">
            <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: "var(--grad)" }} />
          </div>
        </section>

        <section
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-dashed border-line-strong px-6 py-10 text-center text-sm text-text-dim transition-colors hover:border-peach hover:text-text"
        >
          <p>Drag a file here, or click to choose one.</p>
          <p className="text-xs text-text-faint">JPG, PNG, WebP, MP3, OGG, WAV, MP4, WebM</p>
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
                  <span className="text-text-dim">{f.error ? "failed" : `${f.pct}%`}</span>
                </div>
                {f.error ? (
                  <p className="text-red-400">{f.error}</p>
                ) : (
                  <div className="h-1 w-full rounded-full bg-surface-2">
                    <div className="h-1 rounded-full" style={{ width: `${f.pct}%`, background: "var(--grad)" }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <section className="flex flex-col gap-3">
          {files.length === 0 && <p className="text-sm text-text-dim">No files yet.</p>}
          {files.map((file) => (
            <div key={file.id} className="flex items-center gap-4 rounded-[var(--radius)] border border-line bg-surface p-3 text-sm">
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
                    className="w-full rounded border border-line-strong bg-surface-2 px-2 py-1"
                  />
                ) : (
                  <p className="truncate font-medium">{file.original_name}</p>
                )}
                <p className="text-xs text-text-dim">
                  {file.kind} · {formatBytes(file.size_bytes)}
                </p>
                <p className="truncate text-xs text-text-faint">{file.url}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button onClick={() => copyUrl(file.url)} className="rounded border border-line-strong px-2 py-1 hover:bg-surface-2">
                  Copy URL
                </button>
                <button onClick={() => setRenamingId(file.id)} className="rounded border border-line-strong px-2 py-1 hover:bg-surface-2">
                  Rename
                </button>
                <button onClick={() => handleDelete(file)} className="rounded border border-red-900 px-2 py-1 text-red-400 hover:bg-red-950">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
