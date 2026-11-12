// Supabase sends the browser back with `error`, `error_code` and
// `error_description` (in the query string and/or the hash) when an email
// link (confirmation, password reset) can't be used. These helpers turn that
// into a message the app can show.

const MESSAGES: Record<string, string> = {
  otp_expired:
    "That email link has already been used or has expired. If you already confirmed your email, just sign in. Otherwise, request a new link.",
  access_denied: "That email link couldn't be used. Please sign in, or request a new link.",
};

const GENERIC = "That email link couldn't be used. Please sign in, or request a new link.";

/** Returns the auth error code carried by a URL, or null when there is none. */
export function authErrorCode(href: string): string | null {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const pick = (k: string) => url.searchParams.get(k) || hash.get(k);
  if (!pick("error") && !pick("error_code")) return null;
  return pick("error_code") || pick("error") || "unknown";
}

/** Friendly text for an auth error code. Only known codes map to specific text. */
export function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? GENERIC;
}
