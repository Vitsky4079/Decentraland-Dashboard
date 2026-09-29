import { accountUrl } from "@/lib/main-site";
import { LogoutLink } from "./logout-link";

// Visually matches ../../assets/dcl.css's .nav -- same logo, same "pill CTA" idea --
// so Drive reads as part of the same product, not a separate app bolted on.
export function SiteHeader({ email }: { email?: string }) {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-[rgba(13,11,18,.82)] backdrop-blur-md">
      <div className="mx-auto flex h-[68px] max-w-5xl items-center gap-6 px-6">
        <a href="https://decentraland-dashboard.org" className="flex items-center gap-2.5 text-[17.5px] font-bold">
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG, next/image's optimizer adds nothing here and needs an SVG opt-in flag */}
          <img src="/brand/icon-color.svg" alt="" width={27} height={27} className="rounded-full" />
          Decentraland · Drive
        </a>
        <div className="ml-auto flex items-center gap-4 text-sm">
          {email ? (
            <>
              <span className="text-text-dim">{email}</span>
              <LogoutLink />
            </>
          ) : (
            <a
              href={accountUrl()}
              className="rounded-full px-4 py-1.5 text-[13px] font-bold text-[#1A0710]"
              style={{ background: "var(--grad)" }}
            >
              Log in
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
