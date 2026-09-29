import { createClient } from "@/lib/supabase/server";
import { accountUrl } from "@/lib/main-site";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PageHero } from "@/components/page-hero";
import { Lock } from "lucide-react";
import { redirect } from "next/navigation";

const SAMPLE_FILES = [
  { name: "cyberpunk-billboard.png", kind: "image", size: "2.1 MB" },
  { name: "lobby-ambience.mp3", kind: "audio", size: "4.8 MB" },
  { name: "intro-cutscene.mp4", kind: "video", size: "38 MB" },
] as const;

const TABS = [
  { label: "All", count: SAMPLE_FILES.length, active: true },
  { label: "Photos", count: 1, active: false },
  { label: "Audio", count: 1, active: false },
  { label: "Videos", count: 1, active: false },
];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Signed-in visitors don't need the pitch -- straight to the actual product.
  if (user) redirect("/dashboard");

  return (
    <>
      <SiteHeader />
      <PageHero
        eyebrow="Land explorer for your files"
        title={
          <>
            Host your scene&apos;s media, <span className="grad">get a permanent link.</span>
          </>
        }
        sub="Upload images, audio and video, and get back a permanent, Decentraland-compatible HTTPS URL to paste straight into a scene's VideoPlayer, material texture, or AudioSource. No AWS account, no bucket policies -- just drag, drop, copy the link."
      />

      <main>
        <section>
          {/* Same layout/classes as the real dashboard (dashboard-client.tsx) so a
              logged-out visitor sees exactly what they'll get -- just gated behind
              login instead of a separate "preview" mockup. */}
          <div className="wrap wrap-narrow" style={{ paddingTop: 40, paddingBottom: 72, display: "flex", flexDirection: "column", gap: 32 }}>
            <a href={accountUrl()} className="report-btn" style={{ alignSelf: "flex-start" }}>
              Get started — it&apos;s free
            </a>

            <a
              href={accountUrl()}
              className="flex flex-col items-center justify-center gap-2 text-center text-sm"
              style={{
                border: "2px dashed var(--line-strong)",
                borderRadius: "var(--radius)",
                padding: "48px 24px",
                color: "var(--text-dim)",
                textDecoration: "none",
              }}
            >
              <Lock size={18} style={{ color: "var(--text-faint)", marginBottom: 4 }} />
              <p style={{ color: "var(--text)", fontWeight: 600 }}>Log in to upload your files</p>
              <p className="text-xs" style={{ color: "var(--text-faint)" }}>JPG, PNG, WebP · MP3, OGG, WAV · MP4, WebM</p>
            </a>

            <section className="flex flex-col gap-4">
              <div className="drive-tabs" aria-hidden="true">
                {TABS.map((t) => (
                  <span key={t.label} className={`drive-tab${t.active ? " is-active" : ""}`}>
                    {t.label} ({t.count})
                  </span>
                ))}
              </div>

              <div className="flex flex-col gap-3">
                {SAMPLE_FILES.map((f) => (
                  <div key={f.name} className="svc flex items-center gap-4 text-sm" style={{ padding: "16px 20px" }}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate" style={{ fontWeight: 600 }}>{f.name}</p>
                      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
                        <span className="kind-badge">
                          <span className={`kind-dot ${f.kind}`} />
                          {f.kind} · {f.size}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <p className="flex items-center justify-center gap-2 text-sm" style={{ color: "var(--text-dim)" }}>
              <Lock size={14} style={{ flexShrink: 0 }} />
              Log in to start hosting your own scene media.
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
