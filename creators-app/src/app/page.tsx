import { createClient } from "@/lib/supabase/server";
import { accountUrl } from "@/lib/main-site";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PageHero } from "@/components/page-hero";
import { redirect } from "next/navigation";

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
          <div className="wrap wrap-narrow">
            <a href={accountUrl()} className="report-btn">
              Get started — it&apos;s free
            </a>

            {/* Static preview of the real dashboard -- not interactive, just gives a
                logged-out visitor a sense of what they'll get before signing up. */}
            <div className="svc" style={{ marginTop: 48, padding: 24 }}>
              <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-faint)", marginBottom: 16 }}>
                <span>Preview</span>
                <span>you@example.com</span>
              </div>
              <div className="flex justify-between text-sm" style={{ marginBottom: 4 }}>
                <span>Storage used</span>
                <span style={{ color: "var(--text-dim)" }}>1.2 GB / 5.0 GB</span>
              </div>
              <div style={{ height: 8, width: "100%", borderRadius: 999, background: "var(--surface-2)", marginBottom: 24 }}>
                <div style={{ height: 8, width: "24%", borderRadius: 999, background: "var(--grad)" }} />
              </div>
              <div className="flex flex-col gap-2">
                {[
                  { name: "cyberpunk-billboard.png", kind: "image", size: "2.1 MB" },
                  { name: "lobby-ambience.mp3", kind: "audio", size: "4.8 MB" },
                  { name: "intro-cutscene.mp4", kind: "video", size: "38 MB" },
                ].map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center justify-between text-sm"
                    style={{ borderRadius: 10, border: "1px solid var(--line)", padding: "10px 14px" }}
                  >
                    <span>{f.name}</span>
                    <span style={{ color: "var(--text-faint)" }}>
                      {f.kind} · {f.size}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3" style={{ marginTop: 48 }}>
              <div>
                <div className="svc-name" style={{ fontSize: 16 }}>Formats</div>
                <p className="svc-desc">JPG, PNG, WebP, MP3, OGG, WAV, MP4, WebM</p>
              </div>
              <div>
                <div className="svc-name" style={{ fontSize: 16 }}>Free tier</div>
                <p className="svc-desc">5 GB of storage per account to start</p>
              </div>
              <div>
                <div className="svc-name" style={{ fontSize: 16 }}>One account</div>
                <p className="svc-desc">Same login as decentraland-dashboard.org</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
