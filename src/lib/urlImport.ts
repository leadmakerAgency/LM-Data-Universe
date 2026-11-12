// Server side of "import from a web address": fetches a CSV / Excel file for
// a signed-in person, refusing anything on a local or private network (the
// host name is resolved and every address checked, again on each redirect).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_URL_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

function v4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v !== 6) return true;
  const s = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Private(mapped[1]);
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
}

export class UrlImportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function checkHost(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UrlImportError(400, "Use an http(s) address");
  if (url.username || url.password) throw new UrlImportError(400, "Addresses with a user name or password aren't supported");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new UrlImportError(400, "That address isn't on the public internet");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new UrlImportError(400, `Couldn't find ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new UrlImportError(400, "That address isn't on the public internet");
}

/** Downloads a file (following up to 5 redirects, each checked). */
export async function fetchPublicFile(raw: string): Promise<{ bytes: ArrayBuffer; type: string; name: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlImportError(400, "That isn't a web address");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      await checkHost(url);
      const res = await fetch(url, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "LM-Data-Universe-Import/1", Accept: "*/*" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) throw new UrlImportError(400, "Too many redirects");
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new UrlImportError(400, "That file isn't public. For Google Sheets, share it so anyone with the link can view.");
      }
      if (!res.ok) throw new UrlImportError(400, `The address answered ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_URL_BYTES) throw new UrlImportError(413, "Files can be up to 20 MB");
      // Read with a size cap (content-length can be missing or wrong).
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const part = reader ? await reader.read() : { done: true as const, value: undefined };
        if (part.done || !part.value) break;
        total += part.value.byteLength;
        if (total > MAX_URL_BYTES) {
          await reader?.cancel();
          throw new UrlImportError(413, "Files can be up to 20 MB");
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const disposition = res.headers.get("content-disposition") ?? "";
      const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const name = decodeURIComponent(fromHeader ?? url.pathname.split("/").filter(Boolean).pop() ?? "Imported");
      return { bytes: bytes.buffer, type: res.headers.get("content-type") ?? "", name };
    }
  } catch (e) {
    if (e instanceof UrlImportError) throw e;
    if (e instanceof Error && e.name === "AbortError") throw new UrlImportError(504, "The address took too long to answer");
    throw new UrlImportError(400, "Couldn't download that address");
  } finally {
    clearTimeout(timer);
  }
}
