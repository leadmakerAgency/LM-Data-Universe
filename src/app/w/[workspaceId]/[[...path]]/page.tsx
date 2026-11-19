"use client";

import { useParams } from "next/navigation";
import { WorkspaceScreen } from "@/components/hub/WorkspaceScreen";

export default function WorkspacePage() {
  const { workspaceId, path } = useParams<{ workspaceId: string; path?: string[] }>();
  return <WorkspaceScreen key={workspaceId} wsId={workspaceId} path={path ?? []} />;
}
