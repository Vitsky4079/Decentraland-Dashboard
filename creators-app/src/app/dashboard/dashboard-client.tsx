"use client";

import { useRef, useState } from "react";
import { ACCEPT_ATTR, formatBytes } from "@/lib/media-types";
import type { MediaFile } from "@/lib/types";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PageHero } from "@/components/page-hero";
import { LogoutLink } from "@/components/logout-link";
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
      <SiteHeader />
      <PageHero
        eyebrow="Your Drive"
        title={
          <>
            Files ready for <span className="grad">Decentraland.</span>
          </>
        }
        sub={`Signed in as ${email}.`}
        compact
      />

      <main>
        <section>
          <div className="wrap wrap-narrow" style={{ paddingTop: 40, paddingBottom: 72, display: "flex", flexDirection: "column", gap: 32 }}>
            <div className="flex justify-end">
              <LogoutLink />
            </div>

            <section>
              <div className="flex justify-between text-sm" style={{ marginBottom: 4 }}>
                <span>Storage used</span>
                <span style={{ color: "var(--text-dim)" }}>
                  {formatBytes(used)} / {formatBytes(quotaBytes)}
                </span>
              </div>
              <div style={{ height: 8, width: "100%", borderRadius: 999, background: "var(--surface-2)" }}>
                <div style={{ height: 8, borderRadius: 999, width: `${pct}%`, background: "var(--grad)" }} />
              </div>
            </section>

            <section
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 text-center text-sm"
              style={{ border: "2px dashed var(--line-strong)", borderRadius: "var(--radius)", padding: "40px 24px", color: "var(--text-dim)" }}
            >
              <p>Drag a file here, or click to choose one.</p>
              <p className="text-xs" style={{ color: "var(--text-faint)" }}>JPG, PNG, WebP, MP3, OGG, WAV, MP4, WebM</p>
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
                      <span style={{ color: "var(--text-dim)" }}>{f.error ? "failed" : `${f.pct}%`}</span>
                    </div>
                    {f.error ? (
                      <p style={{ color: "var(--red)" }}>{f.error}</p>
                    ) : (
                      <div style={{ height: 4, width: "100%", borderRadius: 999, background: "var(--surface-2)" }}>
                        <div style={{ height: 4, borderRadius: 999, width: `${f.pct}%`, background: "var(--grad)" }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <section className="flex flex-col gap-3">
              {files.length === 0 && <p className="text-sm" style={{ color: "var(--text-dim)" }}>No files yet.</p>}
              {files.map((file) => (
                <div
                  key={file.id}
                  className="svc flex items-center gap-4 text-sm"
                  style={{ padding: "14px 18px" }}
                >
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
                        className="w-full"
                        style={{ borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--surface-2)", padding: "6px 10px" }}
                      />
                    ) : (
                      <p className="truncate font-medium">{file.original_name}</p>
                    )}
                    <p className="text-xs" style={{ color: "var(--text-dim)" }}>
                      {file.kind} · {formatBytes(file.size_bytes)}
                    </p>
                    <p className="truncate text-xs" style={{ color: "var(--text-faint)" }}>{file.url}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => copyUrl(file.url)} className="btn ghost">Copy URL</button>
                    <button onClick={() => setRenamingId(file.id)} className="btn ghost">Rename</button>
                    <button onClick={() => handleDelete(file)} className="btn ghost" style={{ color: "var(--red)" }}>Delete</button>
                  </div>
                </div>
              ))}
            </section>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
