// What the app's sidebar needs about the signed-in person: their profile,
// workspaces and teams with their roles, and whether they're an app admin.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, supabase } from "./supabase";
import type { Profile, Role, Team, Workspace } from "./types";
import { toast } from "@/store/toasts";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const bestRole = (...roles: (Role | undefined)[]): Role | undefined =>
  (roles.filter(Boolean) as Role[]).sort((a, b) => RANK[b] - RANK[a])[0];

export interface AppData {
  profile: Profile | null;
  /** Personal workspace first. */
  workspaces: Workspace[];
  teams: Team[];
  teamRoles: Record<string, Role>;
  isAdmin: boolean;
  /** The person's role in a workspace (a team role counts for every workspace of the team). */
  wsRole: (ws: Workspace | undefined) => Role | undefined;
  loaded: boolean;
  reload: () => Promise<void>;
}

export function useAppData(userId: string | undefined): AppData {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsRoles, setWsRoles] = useState<Record<string, Role>>({});
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamRoles, setTeamRoles] = useState<Record<string, Role>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!userId) return;
    const sb = supabase();
    const [p, w, wm, t, tm, admin] = await Promise.all([
      sb.from("profiles").select("id,email,full_name").eq("id", userId).maybeSingle(),
      sb.from("workspaces").select("*").order("created_at"),
      sb.from("workspace_members").select("workspace_id, role").eq("user_id", userId),
      sb.from("teams").select("*").order("name"),
      sb.from("team_members").select("team_id, role").eq("user_id", userId),
      sb.rpc("is_app_admin"),
    ]);
    const err = [p, w, wm, t, tm].find((r) => r.error)?.error;
    if (err) {
      toast.error(errorMessage(err));
      return;
    }
    setProfile(p.data as Profile);
    setWorkspaces((w.data as Workspace[]).sort((a, b) => Number(b.is_personal) - Number(a.is_personal)));
    setWsRoles(Object.fromEntries((wm.data as { workspace_id: string; role: Role }[]).map((r) => [r.workspace_id, r.role])));
    setTeams(t.data as Team[]);
    setTeamRoles(Object.fromEntries((tm.data as { team_id: string; role: Role }[]).map((r) => [r.team_id, r.role])));
    setIsAdmin(admin.data === true);
    setLoaded(true);
  }, [userId]);

  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
  }, [reload]);

  const wsRole = (ws: Workspace | undefined) => (ws ? bestRole(wsRoles[ws.id], ws.team_id ? teamRoles[ws.team_id] : undefined) : undefined);
  return { profile, workspaces, teams, teamRoles, isAdmin, wsRole, loaded, reload };
}

/** Remembers the open workspace, so "/" comes back to it. */
export function rememberWorkspace(id: string) {
  try {
    window.localStorage.setItem("lmdu-last-ws", id);
  } catch {
    /* not remembered */
  }
}

export function lastWorkspace(): string | null {
  try {
    return window.localStorage.getItem("lmdu-last-ws");
  } catch {
    return null;
  }
}
