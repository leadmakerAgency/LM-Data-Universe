"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { Button, Spinner } from "./ui";
import { setShareToken, supabase } from "@/lib/supabase";

/** /s/<token>: remembers the link's token for this tab and opens its document. */
export function ShareLinkLanding({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!/^[0-9a-f]{16,64}$/i.test(token)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("This link isn't valid.");
      return;
    }
    setShareToken(token);
    void supabase()
      .rpc("share_link_access")
      .then(({ data, error: e }) => {
        const row = Array.isArray(data) ? data[0] : data;
        if (e || !row?.doc_id) {
          setShareToken(null);
          setError("This link has expired, was turned off, or needs you to sign in first.");
          return;
        }
        // Embed codes add ?embed=1 (and &nav=1, &page=<id>): pass them on.
        const from = new URLSearchParams(window.location.search);
        const keep = new URLSearchParams();
        for (const k of ["embed", "nav", "page"]) {
          const v = from.get(k);
          if (v && /^[\w-]{1,64}$/.test(v)) keep.set(k, v);
        }
        router.replace(`/doc/${row.doc_id}${keep.size ? `?${keep}` : ""}`);
      });
  }, [token, router]);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo />
      {error ? (
        <>
          <p className="text-sm text-gray-600">{error}</p>
          <Link href={`/login?next=${encodeURIComponent(`/s/${token}`)}`}>
            <Button>Sign in</Button>
          </Link>
        </>
      ) : (
        <Spinner />
      )}
    </div>
  );
}
