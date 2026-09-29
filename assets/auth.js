// Regular user accounts (sign up / log in) for decentraland-dashboard.org and
// drive.decentraland-dashboard.org -- one account works on both.
//
// This is deliberately NOT the same client as dcl.js's authClient() (admin.html's
// login). That one is plain @supabase/supabase-js with the default per-origin
// localStorage session, which is exactly right for a single-page admin panel. This
// one needs the session visible on a *different* subdomain (creators-app), which
// localStorage can never do -- only a cookie can, and only if both sides read/write
// the same cookie the same way. @supabase/ssr's createBrowserClient is what
// creators-app uses server-side for that; importing the same package here (matching
// version) guarantees identical cookie format/chunking on both sides, rather than
// hand-rolling a second, possibly-incompatible cookie scheme.
//
// This is a module script (see account.html) specifically so this CDN import works
// without a build step -- classic <script> tags can't import npm packages this way.
// `?deps=` pins the transitive @supabase/supabase-js version esm.sh bundles for this
// import -- without it, esm.sh resolves peer deps to whatever's currently latest,
// which is how a page can silently start using an auth-js version that doesn't have
// a method this file relies on (signInWithWeb3, added relatively recently). Pinned to
// the exact version installed in creators-app so both sides of this app run the same
// auth-js build.
import { createBrowserClient } from 'https://esm.sh/@supabase/ssr@0.12.7?deps=@supabase/supabase-js@2.117.2';

// Match dcl.js's defensive lookup: a classic <script> (config.js) and a module
// script don't necessarily share top-level `const` bindings the same way, so go
// through `window` explicitly rather than relying on a bare identifier.
const CFG = (typeof window !== 'undefined' && window.DCL_CONFIG) || (typeof DCL_CONFIG !== 'undefined' ? DCL_CONFIG : null);
const sb = (CFG && CFG.supabase) || {};

// A cookie's Domain attribute has to match the current host (or a parent of it) or
// the browser silently drops it -- so this only applies on the real domain, never on
// localhost or a Vercel preview URL, where the default (host-only) cookie is correct.
const COOKIE_DOMAIN = /(^|\.)decentraland-dashboard\.org$/.test(location.hostname)
  ? '.decentraland-dashboard.org'
  : undefined;

// An explicit, distinct storageKey (default would collide with dcl.js's plain
// admin client, which triggers Supabase's "multiple GoTrueClient instances" warning
// even though they use different storage backends underneath).
export const supabase = sb.url && sb.anonKey
  ? createBrowserClient(sb.url, sb.anonKey, {
      cookieOptions: { domain: COOKIE_DOMAIN },
      auth: { storageKey: 'sb-decentraland-account' },
    })
  : null;

export async function getSession() {
  if (!supabase) return null;
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function signUp(email, password) {
  return supabase.auth.signUp({ email, password });
}

export async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

// Redirects the browser to Google, then back to `redirectTo` with the session
// already established -- there's no in-page result to handle on success.
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}/account` },
  });
}

// Unlike OAuth, this never navigates away: it calls into window.ethereum directly
// (connect + a personal_sign of a Supabase-issued SIWE message) and resolves with a
// session in-page, or an error if there's no wallet / the user rejects either step.
export async function signInWithEthereum() {
  // supabase-js rejects (rather than resolving with {error}) for some failure paths
  // here -- no wallet installed, in particular -- so this always needs a catch, or a
  // caller doing `const { error } = await signInWithEthereum()` never gets a chance
  // to see it and the UI hangs on whatever "connecting…" state it was in.
  try {
    return await supabase.auth.signInWithWeb3({
      chain: 'ethereum',
      statement: 'Sign in to Decentraland · Status to manage your Drive.',
    });
  } catch (err) {
    return { data: { session: null, user: null }, error: err };
  }
}
