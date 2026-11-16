/**
 * The in-app path to continue to after signing in. Anything that would leave
 * this site (`https://…`, `//host`, `/\host`, …) becomes "/".
 */
export function safeNext(next: string | null | undefined): string {
  const raw = next || "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  try {
    const base = "http://app.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
