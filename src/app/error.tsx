"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

// Shown when a page throws while rendering. The message helps tell a bug from
// a temporary problem; "Try again" re-renders without a full reload.
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const message = error instanceof Error ? error.message : String(error);
  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
        <AlertTriangle className="mx-auto mb-3 text-amber-500" size={32} />
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-2 break-words text-sm text-gray-600">{message}</p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={() => retry()} className="h-9 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
            Try again
          </button>
          <Link href="/" className="inline-flex h-9 items-center rounded-md border border-gray-300 px-4 text-sm font-medium hover:bg-gray-50">
            Back to documents
          </Link>
        </div>
      </div>
    </main>
  );
}
