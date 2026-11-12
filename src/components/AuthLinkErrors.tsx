"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authErrorCode } from "@/lib/authLinkError";

// When an email link fails, Supabase redirects to the Site URL (often "/")
// with the error in the URL. Send the user to the sign-in page with a readable
// message instead of silently dropping it.
export function AuthLinkErrors() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/auth/callback" || pathname === "/login") return;
    const code = authErrorCode(window.location.href);
    if (code) router.replace(`/login?auth_error=${encodeURIComponent(code)}`);
  }, [pathname, router]);

  return null;
}
