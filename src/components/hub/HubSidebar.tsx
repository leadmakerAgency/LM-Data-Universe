"use client";

// The app's one left sidebar: the workspace switcher (with workspace and team
// management), the workspace's sections, Invoices, Documents, Shared with me,
// Trash, and the account menu.
import clsx from "clsx";
import {
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronsUpDown,
  FileText,
  Folder,
  Gauge,
  Images,
  Kanban,
  KeyRound,
  LayoutDashboard,
  List,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Receipt,
  ScrollText,
  Share2,
  ShieldCheck,
  SquareChartGantt,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiKeysDialog } from "@/components/ApiKeysDialog";
import { Logo } from "@/components/Logo";
import { ShareDialog } from "@/components/ShareDialog";
import { UsageDialog } from "@/components/UsageDialog";
import { Avatar, IconButton, MenuDivider, MenuItem, Popover, useDialogs } from "@/components/ui";
import type { AppData } from "@/lib/appData";
import { downloadAuditCsv } from "@/lib/audit";
import type { HubSection, SectionIcon } from "@/lib/hub";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Team, Workspace } from "@/lib/types";
import { toast } from "@/store/toasts";

export const SECTION_ICONS: Record<SectionIcon, React.ComponentType<{ size?: number; className?: string }>> = {
  users: Users,
  kanban: Kanban,
  gantt: SquareChartGantt,
  images: Images,
  list: List,
  calendar: CalendarDays,
};

function Item({ href, active, icon, children }: { href: string; active: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link href={href} className={clsx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm", active ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100")}>
      <span className="opacity-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

export function HubSidebar({
  app,
  userId,
  wsId,
  sections,
  active,
  client,
  canEdit,
  onAddSection,
}: {
  app: AppData;
  userId: string;
  wsId: string;
  sections: HubSection[];
  /** "overview", a section key, "client", "invoices", "documents", "shared" or "trash". */
  active: string;
  /** The selected client, kept when moving between sections. */
  client: number | null;
  canEdit: boolean;
  onAddSection: () => void;
}) {
  const router = useRouter();
  const { confirm, prompt } = useDialogs();
  const [switcher, setSwitcher] = useState<HTMLElement | null>(null);
  const [teamMenu, setTeamMenu] = useState<{ el: HTMLElement; team: Team } | null>(null);
  const [account, setAccount] = useState<HTMLElement | null>(null);
  const [share, setShare] = useState<{ kind: "workspace" | "team"; id: string; title: string; canManage: boolean } | null>(null);
  const [usage, setUsage] = useState<{ team: Team | null } | null>(null);
  const [apiKeys, setApiKeys] = useState(false);
  const { workspaces, teams, teamRoles, profile } = app;
  const ws = workspaces.find((w) => w.id === wsId);
  const team = ws?.team_id ? teams.find((t) => t.id === ws.team_id) : undefined;
  const isOwner = app.wsRole(ws) === "owner";
  const q = client ? `?client=${client}` : "";
  const base = `/w/${wsId}`;
  const close = () => (setSwitcher(null), setTeamMenu(null));

  const newWorkspace = async (teamId?: string) => {
    close();
    const name = await prompt({ title: "New workspace", label: "Workspace name", confirmLabel: "Create" });
    if (!name) return;
    const { data, error } = await supabase().from("workspaces").insert({ name: name.trim(), owner_id: userId, team_id: teamId ?? null }).select().single();
    if (error) return toast.error(errorMessage(error));
    await app.reload();
    router.push(`/w/${data.id}`);
  };
  const newTeam = async () => {
    close();
    const name = await prompt({ title: "New team", label: "Team name", confirmLabel: "Create team" });
    if (!name) return;
    const { data, error } = await supabase().from("teams").insert({ name: name.trim(), created_by: userId }).select().single();
    if (error) return toast.error(errorMessage(error));
    const w = await supabase().from("workspaces").insert({ name: "General", owner_id: userId, team_id: data.id }).select().single();
    await app.reload();
    if (!w.error) router.push(`/w/${w.data.id}`);
    setShare({ kind: "team", id: data.id, title: data.name, canManage: true });
  };
  const renameWorkspace = async (w: Workspace) => {
    close();
    const name = await prompt({ title: "Rename workspace", label: "Workspace name", initial: w.name });
    if (!name) return;
    const { error } = await supabase().from("workspaces").update({ name: name.trim() }).eq("id", w.id);
    if (error) return toast.error(errorMessage(error));
    void app.reload();
  };
  const deleteWorkspace = async (w: Workspace) => {
    close();
    const ok = await confirm({ title: "Delete workspace?", message: `“${w.name}”, its sections, invoices and all of its documents will be permanently deleted.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const { error } = await supabase().from("workspaces").delete().eq("id", w.id);
    if (error) return toast.error(errorMessage(error));
    await app.reload();
    router.push(`/w/${workspaces.find((x) => x.id !== w.id)?.id ?? ""}`);
  };
  const renameTeam = async (t: Team) => {
    close();
    const name = await prompt({ title: "Rename team", label: "Team name", initial: t.name });
    if (!name) return;
    const { error } = await supabase().from("teams").update({ name: name.trim() }).eq("id", t.id);
    if (error) return toast.error(errorMessage(error));
    void app.reload();
  };
  const deleteTeam = async (t: Team) => {
    close();
    const ok = await confirm({
      title: `Delete team “${t.name}”?`,
      message: "Members lose the access the team gave them. The team's workspaces and documents are kept, and people added to them directly keep their access.",
      confirmLabel: "Delete team",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase().from("teams").delete().eq("id", t.id);
    if (error) return toast.error(errorMessage(error));
    void app.reload();
  };
  const auditLog = async (t: Team) => {
    close();
    try {
      const n = await downloadAuditCsv({ team: t.id }, `${t.name} audit log.csv`);
      toast.info(`${n} event${n === 1 ? "" : "s"} downloaded`);
    } catch (e) {
      toast.error(`Could not download the audit log: ${errorMessage(e)}`);
    }
  };

  const wsLink = (w: Workspace) => {
    const t = w.team_id ? teams.find((x) => x.id === w.team_id) : undefined;
    return (
      <Link key={w.id} href={`/w/${w.id}`} onClick={close} className={clsx("flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100", w.id === wsId && "font-medium text-brand-700")}>
        {t ? <Building2 size={14} className="text-gray-400" /> : <Folder size={14} className="text-gray-400" />}
        <span className="min-w-0 flex-1 truncate">{w.name}</span>
      </Link>
    );
  };
  const name = profile?.full_name || profile?.email || "Account";

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex h-14 items-center px-4">
        <Link href={base} title="Overview">
          <Logo />
        </Link>
      </div>
      <div className="px-3 pb-2">
        <button className="flex w-full items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 text-left hover:bg-gray-50" onClick={(e) => setSwitcher(e.currentTarget)}>
          {team ? <Building2 size={15} className="text-gray-500" /> : <Folder size={15} className="text-gray-500" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{ws?.name ?? "Workspace"}</span>
            {team && <span className="block truncate text-[11px] text-gray-500">{team.name}</span>}
          </span>
          <ChevronsUpDown size={14} className="text-gray-400" />
        </button>
      </div>
      <nav className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Sections">
        <Item href={`${base}${q}`} active={active === "overview"} icon={<LayoutDashboard size={16} />}>
          Overview
        </Item>
        {sections
          .filter((s) => !s.hidden)
          .map((s) => {
            const Icon = SECTION_ICONS[s.icon] ?? List;
            return (
              <Item key={s.key} href={`${base}/${s.key}${q}`} active={active === s.key || (s.key === "clients" && active === "client")} icon={<Icon size={16} />}>
                {s.label}
              </Item>
            );
          })}
        <Item href={`${base}/invoices${q}`} active={active === "invoices"} icon={<Receipt size={16} />}>
          Invoices
        </Item>
        {canEdit && (
          <button className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-100 hover:text-brand-700" onClick={onAddSection}>
            <Plus size={16} className="opacity-70" /> Add a section
          </button>
        )}
        <div className="my-2 border-t border-gray-100" />
        <Item href={`${base}/documents`} active={active === "documents"} icon={<FileText size={16} />}>
          Documents
        </Item>
        <Item href={`${base}/shared`} active={active === "shared"} icon={<Users size={16} />}>
          Shared with me
        </Item>
        <Item href={`${base}/trash`} active={active === "trash"} icon={<Trash2 size={16} />}>
          Trash
        </Item>
      </nav>

      <button onClick={(e) => setAccount(e.currentTarget)} className="flex items-center gap-2 border-t border-gray-100 px-4 py-3 text-left hover:bg-gray-50">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{profile?.full_name || "Account"}</div>
          <div className="truncate text-xs text-gray-500">{profile?.email}</div>
        </div>
        <ChevronDown size={14} className="text-gray-400" />
      </button>

      {/* Workspaces and teams */}
      <Popover anchor={switcher} onClose={() => setSwitcher(null)}>
        <div className="scroll-thin max-h-[70vh] w-64 overflow-y-auto">
          {ws && (
            <>
              <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">This workspace</div>
              {!ws.is_personal && (
                <MenuItem icon={<Share2 size={14} />} onClick={() => (close(), setShare({ kind: "workspace", id: ws.id, title: ws.name, canManage: isOwner }))}>
                  Members and sharing
                </MenuItem>
              )}
              {isOwner && (
                <MenuItem icon={<Pencil size={14} />} onClick={() => void renameWorkspace(ws)}>
                  Rename
                </MenuItem>
              )}
              {isOwner && !ws.is_personal && (
                <MenuItem icon={<Trash2 size={14} />} danger onClick={() => void deleteWorkspace(ws)}>
                  Delete workspace
                </MenuItem>
              )}
              <MenuDivider />
            </>
          )}
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Workspaces</div>
          {workspaces.filter((w) => !w.team_id || !teams.some((t) => t.id === w.team_id)).map(wsLink)}
          {teams.map((t) => (
            <div key={t.id} className="mt-1">
              <div className="flex items-center justify-between pl-3 pr-1.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Users size={11} /> <span className="truncate">{t.name}</span>
                </span>
                <IconButton title="Team options" className="h-6 w-6" onClick={(e) => setTeamMenu({ el: e.currentTarget, team: t })}>
                  <MoreHorizontal size={14} />
                </IconButton>
              </div>
              {workspaces.filter((w) => w.team_id === t.id).map(wsLink)}
            </div>
          ))}
          <MenuDivider />
          <MenuItem icon={<Plus size={14} />} onClick={() => void newWorkspace()}>
            New workspace
          </MenuItem>
          <MenuItem icon={<Users size={14} />} onClick={() => void newTeam()}>
            New team
          </MenuItem>
        </div>
      </Popover>

      <Popover anchor={teamMenu?.el ?? null} onClose={() => setTeamMenu(null)} align="end">
        {teamMenu && (
          <>
            <MenuItem icon={<Users size={15} />} onClick={() => (close(), setShare({ kind: "team", id: teamMenu.team.id, title: teamMenu.team.name, canManage: teamRoles[teamMenu.team.id] === "owner" }))}>
              Members
            </MenuItem>
            <MenuItem icon={<Plus size={15} />} disabled={!["owner", "editor"].includes(teamRoles[teamMenu.team.id] ?? "")} onClick={() => void newWorkspace(teamMenu.team.id)}>
              New workspace in team
            </MenuItem>
            <MenuItem icon={<Gauge size={15} />} onClick={() => (close(), setUsage({ team: teamMenu.team }))}>
              Plan and usage
            </MenuItem>
            {teamRoles[teamMenu.team.id] === "owner" && (
              <>
                <MenuItem icon={<ScrollText size={15} />} onClick={() => void auditLog(teamMenu.team)}>
                  Download audit log
                </MenuItem>
                <MenuItem icon={<Pencil size={15} />} onClick={() => void renameTeam(teamMenu.team)}>
                  Rename team
                </MenuItem>
                <MenuDivider />
                <MenuItem icon={<Trash2 size={15} />} danger onClick={() => void deleteTeam(teamMenu.team)}>
                  Delete team
                </MenuItem>
              </>
            )}
          </>
        )}
      </Popover>

      {/* Account */}
      <Popover anchor={account} onClose={() => setAccount(null)}>
        <MenuItem icon={<Gauge size={15} />} onClick={() => (setAccount(null), setUsage({ team: null }))}>
          Plan and usage
        </MenuItem>
        <MenuItem icon={<KeyRound size={15} />} onClick={() => (setAccount(null), setApiKeys(true))}>
          API keys
        </MenuItem>
        {app.isAdmin && (
          <MenuItem icon={<ShieldCheck size={15} />} onClick={() => (setAccount(null), router.push("/admin"))}>
            Admin panel
          </MenuItem>
        )}
        <MenuDivider />
        <MenuItem
          icon={<LogOut size={15} />}
          onClick={async () => {
            await supabase().auth.signOut();
            router.replace("/login");
          }}
        >
          Sign out
        </MenuItem>
      </Popover>

      {apiKeys && <ApiKeysDialog onClose={() => setApiKeys(false)} />}
      {usage && <UsageDialog team={usage.team} onClose={() => setUsage(null)} />}
      {share && <ShareDialog open onClose={() => (setShare(null), void app.reload())} kind={share.kind} targetId={share.id} title={share.title} canManage={share.canManage} currentUserId={userId} />}
    </aside>
  );
}
