"use client";

// "/" opens the last workspace you used (everything else lives in its sidebar).
// Older links still work: /?ws=<id> → its documents, /?view=shared|trash.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Spinner } from "@/components/ui";
import { lastWorkspace } from "@/lib/appData";
import { useRequireSession } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Workspace } from "@/lib/types";

export default function Home() {
  const session = useRequireSession();
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let live = true;
    void supabase()
      .from("workspaces")
      .select("id,is_personal,created_at")
      .order("created_at")
      .then(({ data, error }) => {
        if (!live) return;
        if (error) return setProblem(errorMessage(error));
        const list = ((data as Workspace[] | null) ?? []).sort((a, b) => Number(b.is_personal) - Number(a.is_personal));
        const qs = new URLSearchParams(window.location.search);
        const asked = qs.get("ws");
        const view = qs.get("view");
        const target = list.find((w) => w.id === asked) ?? list.find((w) => w.id === lastWorkspace()) ?? list[0];
        if (!target) return setProblem("You don't have a workspace yet.");
        const path = asked ? "/documents" : view === "shared" || view === "trash" ? `/${view}` : "";
        router.replace(`/w/${target.id}${path}`);
      });
    return () => {
      live = false;
    };
  }, [session, router]);

  if (problem)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-600">
        <p>{problem}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}
