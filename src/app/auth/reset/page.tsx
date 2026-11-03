"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, Label, Spinner } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { supabase, errorMessage } from "@/lib/supabase";
import { useSession } from "@/lib/session";
import { toast } from "@/store/toasts";

export default function ResetPasswordPage() {
  const router = useRouter();
  const session = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    toast.success("Password updated");
    router.replace("/");
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-50 via-white to-sky-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        {session === undefined ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : !session ? (
          <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
            This reset link is invalid or has expired.{" "}
            <a href="/forgot-password" className="font-medium underline">
              Request a new one
            </a>
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-semibold">Choose a new password</h1>
            <div>
              <Label>New password</Label>
              <Input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button variant="primary" className="w-full" disabled={busy}>
              {busy ? "Saving…" : "Save password"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
