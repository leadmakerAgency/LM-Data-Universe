"use client";

import { AlertTriangle } from "lucide-react";
import { catchError, type ErrorInfo } from "next/error";

/** Contains a rendering error to one part of the screen (e.g. a single widget). */
function Fallback(props: { label?: string; children?: React.ReactNode }, { error, retry }: ErrorInfo) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <AlertTriangle size={20} className="text-amber-500" />
      <div className="text-sm font-medium">{props.label ?? "This part couldn't be displayed"}</div>
      <div className="max-w-sm break-words text-xs text-gray-500">{message}</div>
      <button onClick={() => retry()} className="mt-1 rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-50">
        Try again
      </button>
    </div>
  );
}

export const ErrorBoundary = catchError(Fallback);
