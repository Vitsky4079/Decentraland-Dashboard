"use client";

import { useMemo, useRef, useState } from "react";
import { ACCEPT_ATTR, formatBytes, type MediaKind } from "@/lib/media-types";
import type { MediaFile } from "@/lib/types";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PageHero } from "@/components/page-hero";
import { LogoutLink } from "@/components/logout-link";
import { uploadFile } from "./upload";
import { readVideoInfo } from "@/lib/video-info";

type InFlight = { id: string; name: string; pct: number; error?: string };
type Notice = { id: string; fileName: string; detail: string };

// 10-bit video uploads fine but the Explorer's player can't play it (8-bit H.264 and HEVC both do).
function convertCommand(fileName: string) {
  const input = fileName.replace(/["\\]/g, "");
  return `ffmpeg -i "${input}" -c:v libx264 -pix_fmt yuv420p -crf 20 -c:a aac -b:a 192k -movflags +faststart converted.mp4`;
}
type Tab = "all" | MediaKind;
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Photos" },
  { id: "audio", label: "Audio" },
  { id: "video", label: "Videos" },
];

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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [copiedNoticeId, setCopiedNoticeId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  function handleFiles(list: FileList | null) {
    if (!list) return;
    Array.from(list).forEach((file) => {
      const id = crypto.randomUUID();
      setInFlight((prev) => [...prev, { id, name: file.name, pct: 0 }]);
      readVideoInfo(file).then((info) => {
        if (info && info.bitDepth > 8) {
          setNotices((prev) => [...prev, { id, fileName: file.name, detail: `${info.codec.toUpperCase()} ${info.bitDepth}-bit` }]);
        }
      });
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

  function copyUrl(id: string, url: string) {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
      })
      .catch(() => {});
  }

  function copyCommand(notice: Notice) {
    navigator.clipboard
      .writeText(convertCommand(notice.fileName))
      .then(() => {
        setCopiedNoticeId(notice.id);
        setTimeout(() => setCopiedNoticeId((prev) => (prev === notice.id ? null : prev)), 1500);
      })
      .catch(() => {});
  }

  const pct = quotaBytes > 0 ? Math.min(100, Math.round((used / quotaBytes) * 100)) : 0;
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: files.length, image: 0, audio: 0, video: 0 };
    for (const f of files) c[f.kind]++;
    return c;
  }, [files]);
  const visible = tab === "all" ? files : files.filter((f) => f.kind === tab);

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
            <div className="svc flex items-center" style={{ gap: 24, padding: "20px 24px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex justify-between text-sm" style={{ marginBottom: 4 }}>
                  <span>Storage used</span>
                  <span style={{ color: "var(--text-dim)" }}>
                    {formatBytes(used)} / {formatBytes(quotaBytes)}
                  </span>
                </div>
                <div style={{ height: 8, width: "100%", borderRadius: 999, background: "var(--surface-2)" }}>
                  <div style={{ height: 8, borderRadius: 999, width: `${pct}%`, background: "var(--grad)" }} />
                </div>
              </div>
              <LogoutLink />
            </div>

            <section
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 text-center text-sm"
              style={{ border: "2px dashed var(--line-strong)", borderRadius: "var(--radius)", padding: "48px 24px", color: "var(--text-dim)", transition: "border-color .15s" }}
            >
              <p style={{ color: "var(--text)", fontWeight: 600 }}>Drag a file here, or click to choose one.</p>
              <p className="text-xs" style={{ color: "var(--text-faint)" }}>JPG, PNG, WebP · MP3, OGG, WAV · MP4, WebM</p>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT_ATTR}
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </section>

            {notices.map((n) => (
              <div key={n.id} className="svc text-sm" role="alert" style={{ padding: "14px 18px", borderColor: "var(--peach)" }}>
                <p style={{ fontWeight: 600 }}>
                  {n.fileName} is {n.detail} video -- it may not play in the Decentraland Explorer.
                </p>
                <p className="text-xs" style={{ color: "var(--text-dim)", marginTop: 4 }}>
                  The upload still works and the link is valid, but the Explorer can&apos;t play 10-bit video (8-bit H.264 and HEVC both
                  play fine). Convert it to 8-bit H.264 and upload that version:
                </p>
                <code
                  className="text-xs"
                  style={{ display: "block", marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", overflowX: "auto", whiteSpace: "nowrap", fontFamily: "var(--mono)" }}
                >
                  {convertCommand(n.fileName)}
                </code>
                <div className="flex gap-2" style={{ marginTop: 10 }}>
                  <button onClick={() => copyCommand(n)} className="btn ghost" style={{ padding: "8px 14px", fontSize: 11 }}>
                    {copiedNoticeId === n.id ? "Copied!" : "Copy command"}
                  </button>
                  <button onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))} className="btn ghost" style={{ padding: "8px 14px", fontSize: 11 }}>
                    Dismiss
                  </button>
                </div>
              </div>
            ))}

            {inFlight.length > 0 && (
              <ul className="flex flex-col gap-2">
                {inFlight.map((f) => (
                  <li key={f.id} className="svc text-sm" style={{ padding: "12px 16px" }}>
                    <div className="flex justify-between">
                      <span className="truncate">{f.name}</span>
                      <span style={{ color: f.error ? "var(--red)" : "var(--text-dim)" }}>{f.error ? "Failed" : `${f.pct}%`}</span>
                    </div>
                    {f.error ? (
                      <p className="text-xs" style={{ color: "var(--red)", marginTop: 4 }}>{f.error}</p>
                    ) : (
                      <div style={{ height: 4, width: "100%", borderRadius: 999, background: "var(--surface-2)", marginTop: 8 }}>
                        <div className="upload-bar-fill" style={{ width: `${f.pct}%` }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <section className="flex flex-col gap-4">
              <div className="drive-tabs" role="tablist">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    className={`drive-tab${tab === t.id ? " is-active" : ""}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label} ({counts[t.id]})
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-3">
                {visible.length === 0 && (
                  <p className="empty">
                    {tab === "all" ? "No files yet -- upload one above to get started." : `No ${TABS.find((t) => t.id === tab)?.label.toLowerCase()} yet.`}
                  </p>
                )}
                {visible.map((file) => (
                  <div key={file.id} className="svc flex items-center gap-4 text-sm" style={{ padding: "16px 20px" }}>
                    <div className="min-w-0 flex-1">
                      {renamingId === file.id ? (
                        <input
                          ref={renameInputRef}
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
                        <p className="truncate" style={{ fontWeight: 600 }}>{file.original_name}</p>
                      )}
                      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
                        <span className="kind-badge">
                          <span className={`kind-dot ${file.kind}`} />
                          {file.kind} · {formatBytes(file.size_bytes)}
                        </span>
                      </div>
                      <p className="truncate text-xs" style={{ color: "var(--text-faint)", marginTop: 4 }}>{file.url}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <div style={{ position: "relative" }}>
                        {copiedId === file.id && <span className="copied-badge">Copied!</span>}
                        <button onClick={() => copyUrl(file.id, file.url)} className="btn ghost" style={{ padding: "8px 14px", fontSize: 11 }}>Copy URL</button>
                      </div>
                      <button
                        onMouseDown={(e) => {
                          // Clicking this button while it's in "Save" mode would
                          // otherwise blur the rename input via the browser's default
                          // focus-shift-on-mousedown -- that commits the rename (see
                          // the input's onBlur) *before* this button's own onClick
                          // runs, so onClick would then read renamingId as already
                          // null and immediately reopen rename mode. Suppressing the
                          // default here keeps focus stable until onClick decides.
                          if (renamingId === file.id) e.preventDefault();
                        }}
                        onClick={() => (renamingId === file.id ? renameInputRef.current?.blur() : setRenamingId(file.id))}
                        className="btn ghost"
                        style={{ padding: "8px 14px", fontSize: 11 }}
                      >
                        {renamingId === file.id ? "Save" : "Rename"}
                      </button>
                      <button onClick={() => handleDelete(file)} className="btn ghost" style={{ padding: "8px 14px", fontSize: 11, color: "var(--red)" }}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
