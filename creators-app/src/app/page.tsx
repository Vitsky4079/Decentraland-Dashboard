import { createClient } from "@/lib/supabase/server";
import { accountUrl } from "@/lib/main-site";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PageHero } from "@/components/page-hero";
import { Lock } from "lucide-react";
import { redirect } from "next/navigation";

const TABS = [
  { label: "All", count: 0, active: true },
  { label: "Photos", count: 0, active: false },
  { label: "Audio", count: 0, active: false },
  { label: "Videos", count: 0, active: false },
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
        sub="Upload images, audio and video, and get back a permanent, Decentraland-compatible HTTPS URL to paste straight into a scene's VideoPlayer, material texture, or AudioSource. No AWS account -- just drag, drop, copy the link."
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

              <p className="empty flex items-center justify-center gap-2">
                <Lock size={14} style={{ flexShrink: 0 }} />
                Log in to start hosting your own scene media.
              </p>
            </section>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
