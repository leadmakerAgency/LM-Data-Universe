"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Input, Label } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { supabase, errorMessage } from "@/lib/supabase";
import { useSession } from "@/lib/session";

type Mode = "login" | "signup" | "forgot";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const session = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session && mode !== "forgot") router.replace(next.startsWith("/") ? next : "/");
  }, [session, mode, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sb = supabase();
      const origin = window.location.origin;
      if (mode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: name.trim() },
            emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        if (!data.session) setNotice("Check your inbox to confirm your email address, then sign in.");
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/reset` });
        if (error) throw error;
        setNotice("If an account exists for that email, a reset link is on its way.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Mode, string> = {
    login: "Sign in",
    signup: "Create your account",
    forgot: "Reset your password",
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-50 via-white to-sky-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{titles[mode]}</h1>
          {mode === "signup" && (
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </div>
          )}
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          {mode !== "forgot" && (
            <div>
              <div className="flex items-baseline justify-between">
                <Label>Password</Label>
                {mode === "login" && (
                  <Link href="/forgot-password" className="text-xs text-brand-600 hover:underline">
                    Forgot?
                  </Link>
                )}
              </div>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "signup" ? 8 : undefined}
                required
              />
            </div>
          )}
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
          <Button variant="primary" className="w-full" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-600">
          {mode === "login" ? (
            <>
              New here?{" "}
              <Link href={`/signup${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-brand-600 hover:underline">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-brand-600 hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </main>
  );
}
