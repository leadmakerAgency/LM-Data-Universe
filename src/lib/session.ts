"use client";

import type { Session } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getShareToken, supabase } from "./supabase";

/** Current auth session; `undefined` while loading. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

/**
 * Session for pages that need a signed-in user; redirects to /login otherwise.
 * With `allowShareLink`, a visitor holding a share-link token may stay signed out.
 */
export function useRequireSession(opts: { allowShareLink?: boolean } = {}): Session | null {
  const session = useSession();
  const router = useRouter();
  const allowed = opts.allowShareLink && !!getShareToken();
  useEffect(() => {
    if (session === null && !allowed) {
      const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [session, router, allowed]);
  return session ?? null;
}

/** True once we know there's no session but a share link lets the visitor in. */
export function useLinkVisitor(session: Session | null | undefined): boolean {
  return session === null && !!getShareToken();
}
