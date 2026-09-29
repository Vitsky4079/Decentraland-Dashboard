import Link from "next/link";

// Same markup/classes as ../../assets dcl.js's nav (see account.html) so Drive's
// header is pixel-identical to the main site's, not just similarly colored.
// "Drive" is marked active since this header only ever renders on this app.
export function SiteHeader() {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a className="logo" href="https://decentraland-dashboard.org">
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG, next/image's optimizer adds nothing here and needs an SVG opt-in flag */}
          <img className="logo-mark" src="/brand/icon-color.svg" alt="" width={27} height={27} />
          Decentraland · Status
        </a>
        <div className="nav-links">
          <a href="https://decentraland-dashboard.org/announcements">Announcements</a>
          <a href="https://decentraland-dashboard.org/issues">Known issues</a>
          <a href="https://decentraland-dashboard.org/features">Feature requests</a>
          <a href="https://decentraland-dashboard.org/fixed">Recently fixed</a>
          <a href="https://decentraland-dashboard.org/workarounds">Workarounds</a>
          <a href="https://decentraland-dashboard.org/bundles">Asset bundles</a>
          <a href="https://decentraland-dashboard.org/map">Map</a>
          <Link href="/" className="active">Drive</Link>
          <a href="https://decentraland-dashboard.org/account">Account</a>
          <a className="nav-report" href="https://decentraland-dashboard.org/report">Report a bug</a>
        </div>
      </div>
    </nav>
  );
}
