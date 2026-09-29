import type { ReactNode } from "react";

// Same markup/classes as assets/dcl.css's .hero -- every main-site page opens with
// this pattern (eyebrow, big title, subtitle), so Drive's pages do too.
export function PageHero({ eyebrow, title, sub, compact }: { eyebrow: string; title: ReactNode; sub?: string; compact?: boolean }) {
  return (
    <header className="hero">
      <div className="parcel-grid" aria-hidden="true" />
      <div className={`hero-inner${compact ? " compact" : ""}`}>
        <div className="hero-eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {sub && <p className="hero-sub">{sub}</p>}
      </div>
    </header>
  );
}
