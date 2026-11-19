"use client";

// The app's left sidebar in a workspace: the workspace switcher, the hub's
// sections (Overview, Clients, Pipeline, Planning, Files & assets and any
// added ones), the workspace's documents, and the shared places.
import clsx from "clsx";
import { Building2, CalendarDays, ChevronsUpDown, FileText, Folder, Images, Kanban, LayoutDashboard, LayoutTemplate, List, Plus, Receipt, SquareChartGantt, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/Logo";
import { MenuDivider, MenuItem, Popover } from "@/components/ui";
import type { HubSection, SectionIcon } from "@/lib/hub";
import type { Team, Workspace } from "@/lib/types";

export const SECTION_ICONS: Record<SectionIcon, React.ComponentType<{ size?: number; className?: string }>> = {
  users: Users,
  kanban: Kanban,
  gantt: SquareChartGantt,
  images: Images,
  list: List,
  calendar: CalendarDays,
};

function Item({ href, active, icon, children, count }: { href: string; active: boolean; icon: React.ReactNode; children: React.ReactNode; count?: number }) {
  return (
    <Link
      href={href}
      className={clsx(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm",
        active ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
      )}
    >
      <span className="opacity-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="text-xs text-gray-400">{count}</span>}
    </Link>
  );
}

export function HubSidebar({
  workspaces,
  teams,
  wsId,
  sections,
  active,
  client,
  canEdit,
  onAddSection,
}: {
  workspaces: Workspace[];
  teams: Team[];
  wsId: string;
  sections: HubSection[];
  /** "overview", a section key, "client" or "documents". */
  active: string;
  /** The selected client, kept when moving between sections. */
  client: number | null;
  canEdit: boolean;
  onAddSection: () => void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const ws = workspaces.find((w) => w.id === wsId);
  const team = ws?.team_id ? teams.find((t) => t.id === ws.team_id) : undefined;
  const q = client ? `?client=${client}` : "";
  const base = `/w/${wsId}`;
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex h-14 items-center px-4">
        <Link href={`/?ws=${wsId}`} title="Documents of this workspace">
          <Logo />
        </Link>
      </div>
      <div className="px-3 pb-2">
        <button className="flex w-full items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 text-left hover:bg-gray-50" onClick={(e) => setMenu(e.currentTarget)}>
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
        <Item href={`/?ws=${wsId}`} active={active === "documents"} icon={<FileText size={16} />}>
          Documents
        </Item>
        <Item href="/?view=shared" active={false} icon={<Users size={16} />}>
          Shared with me
        </Item>
        <Item href="/?view=templates" active={false} icon={<LayoutTemplate size={16} />}>
          Templates
        </Item>
        <Item href="/?view=trash" active={false} icon={<Trash2 size={16} />}>
          Trash
        </Item>
      </nav>

      <Popover anchor={menu} onClose={() => setMenu(null)}>
        <div className="scroll-thin max-h-80 w-60 overflow-y-auto">
          {workspaces.map((w) => {
            const t = w.team_id ? teams.find((x) => x.id === w.team_id) : undefined;
            return (
              <Link key={w.id} href={`/w/${w.id}`} onClick={() => setMenu(null)} className={clsx("flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100", w.id === wsId && "font-medium text-brand-700")}>
                {t ? <Building2 size={14} className="text-gray-400" /> : <Folder size={14} className="text-gray-400" />}
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {t && <span className="truncate text-[11px] text-gray-400">{t.name}</span>}
              </Link>
            );
          })}
        </div>
        <MenuDivider />
        <Link href="/" onClick={() => setMenu(null)}>
          <MenuItem icon={<Folder size={14} />} onClick={() => setMenu(null)}>
            Manage workspaces and teams
          </MenuItem>
        </Link>
      </Popover>
    </aside>
  );
}
