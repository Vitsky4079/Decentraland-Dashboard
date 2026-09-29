import { createClient } from "@/lib/supabase/server";
import { accountUrl } from "@/lib/main-site";
import { SiteHeader } from "@/components/site-header";
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
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <p className="text-sm font-semibold tracking-wide text-peach uppercase">Land explorer for your files</p>
        <h1 className="mt-2 text-4xl font-extrabold">
          Host your scene&apos;s media, <span style={{ background: "var(--grad)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>get a permanent link.</span>
        </h1>
        <p className="mt-4 max-w-xl text-text-dim">
          Upload images, audio and video, and get back a permanent, Decentraland-compatible
          HTTPS URL to paste straight into a scene&apos;s <code className="text-text">VideoPlayer</code>,
          material texture, or <code className="text-text">AudioSource</code>. No AWS account,
          no bucket policies -- just drag, drop, copy the link.
        </p>

        <div className="mt-8 flex gap-3">
          <a
            href={accountUrl()}
            className="rounded-full px-6 py-2.5 text-sm font-bold text-[#1A0710]"
            style={{ background: "var(--grad)" }}
          >
            Get started -- it&apos;s free
          </a>
        </div>

        {/* Static preview of the real dashboard -- not interactive, just gives a
            logged-out visitor a sense of what they'll get before signing up. */}
        <div className="mt-14 rounded-[var(--radius)] border border-line bg-surface p-5">
          <div className="mb-4 flex items-center justify-between text-xs text-text-faint">
            <span>Preview</span>
            <span>you@example.com</span>
          </div>
          <div className="mb-1 flex justify-between text-sm">
            <span>Storage used</span>
            <span className="text-text-dim">1.2 GB / 5.0 GB</span>
          </div>
          <div className="mb-6 h-2 w-full rounded-full bg-surface-2">
            <div className="h-2 w-1/4 rounded-full" style={{ background: "var(--grad)" }} />
          </div>
          <div className="flex flex-col gap-2">
            {[
              { name: "cyberpunk-billboard.png", kind: "image", size: "2.1 MB" },
              { name: "lobby-ambience.mp3", kind: "audio", size: "4.8 MB" },
              { name: "intro-cutscene.mp4", kind: "video", size: "38 MB" },
            ].map((f) => (
              <div key={f.name} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                <span className="text-text">{f.name}</span>
                <span className="text-text-faint">
                  {f.kind} · {f.size}
                </span>
              </div>
            ))}
          </div>
        </div>

        <dl className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div>
            <dt className="font-semibold text-text">Formats</dt>
            <dd className="mt-1 text-sm text-text-dim">JPG, PNG, WebP, MP3, OGG, WAV, MP4, WebM</dd>
          </div>
          <div>
            <dt className="font-semibold text-text">Free tier</dt>
            <dd className="mt-1 text-sm text-text-dim">5 GB of storage per account to start</dd>
          </div>
          <div>
            <dt className="font-semibold text-text">One account</dt>
            <dd className="mt-1 text-sm text-text-dim">Same login as decentraland-dashboard.org</dd>
          </div>
        </dl>
      </main>
    </>
  );
}
