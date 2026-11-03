"use client";

import type { Session } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

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

/** Session for pages that need a signed-in user; redirects to /login otherwise. */
export function useRequireSession(): Session | null {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session === null) {
      const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [session, router]);
  return session ?? null;
}
