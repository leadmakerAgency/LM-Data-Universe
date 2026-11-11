import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config";

let client: SupabaseClient | null = null;

// A public share link's token, sent as `x-share-token` with every request so
// the database grants the link's access (see share_link_access()).
const SHARE_KEY = "lmdu-share-token";
let shareToken: string | null = null;

export function getShareToken(): string | null {
  if (shareToken === null && typeof window !== "undefined") {
    try {
      shareToken = window.sessionStorage.getItem(SHARE_KEY) ?? "";
    } catch {
      shareToken = "";
    }
  }
  return shareToken || null;
}

export function setShareToken(token: string | null) {
  shareToken = token ?? "";
  try {
    if (token) window.sessionStorage.setItem(SHARE_KEY, token);
    else window.sessionStorage.removeItem(SHARE_KEY);
  } catch {
    /* storage unavailable: the token lives for this page only */
  }
}

export function supabase(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(SUPABASE_URL, SUPABASE_KEY, {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const token = getShareToken();
          if (!token) return fetch(input, init);
          const headers = new Headers(init?.headers);
          headers.set("x-share-token", token);
          return fetch(input, { ...init, headers });
        },
      },
    });
  }
  return client;
}

/** Fetches every row of a query in pages of 1000 (PostgREST's default cap). */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
