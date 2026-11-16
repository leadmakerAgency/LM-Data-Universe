"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import { supabase, errorMessage } from "@/lib/supabase";
import { authErrorCode } from "@/lib/authLinkError";
import { safeNext } from "@/lib/safeNext";

// Landing page for email confirmation links. The browser client exchanges the
// ?code= parameter for a session on load; we wait for it, then continue.
export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const target = safeNext(url.searchParams.get("next"));
    const sb = supabase();
    const code = url.searchParams.get("code");
    const linkError = authErrorCode(url.href);
    const finish = async () => {
      try {
        if (linkError) {
          // A reused or expired link: the account may already be confirmed,
          // so carry on if a session exists, otherwise explain on sign-in.
          const { data } = await sb.auth.getSession();
          router.replace(data.session ? target : `/login?auth_error=${encodeURIComponent(linkError)}`);
          return;
        }
        const { data } = await sb.auth.getSession();
        if (!data.session && code) {
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) throw error;
        }
        router.replace(target);
      } catch (e) {
        setError(errorMessage(e));
      }
    };
    void finish();
  }, [router]);

  return (
    <main className="flex h-full items-center justify-center">
      {error ? (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}{" "}
          <a href="/login" className="font-medium underline">
            Back to sign in
          </a>
        </p>
      ) : (
        <Spinner />
      )}
    </main>
  );
}
