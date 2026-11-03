"use client";

import clsx from "clsx";
import {
  Building2,
  ChevronDown,
  FilePlus2,
  FileSpreadsheet,
  FolderOpen,
  LayoutTemplate,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { ShareDialog } from "@/components/ShareDialog";
import { Avatar, Button, IconButton, MenuDivider, MenuItem, Popover, Spinner, useDialogs } from "@/components/ui";
import { createDocument, parseImportFile } from "@/lib/docBuilder";
import { useRequireSession } from "@/lib/session";
import { supabase, errorMessage } from "@/lib/supabase";
import { BLANK_DOC, TEMPLATES } from "@/lib/templates";
import type { DocumentRec, Profile, Role, Workspace } from "@/lib/types";
import { toast } from "@/store/toasts";

type View = { kind: "workspace"; id: string } | { kind: "shared" } | { kind: "templates" };

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function HomeScreen() {
  const session = useRequireSession();
  const router = useRouter();
  const { confirm, prompt } = useDialogs();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [wsRoles, setWsRoles] = useState<Record<string, Role>>({});
  const [docs, setDocs] = useState<DocumentRec[]>([]);
  const [docRoles, setDocRoles] = useState<Record<string, Role>>({});
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [newMenu, setNewMenu] = useState<HTMLElement | null>(null);
  const [docMenu, setDocMenu] = useState<{ el: HTMLElement; doc: DocumentRec } | null>(null);
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const [share, setShare] = useState<{ kind: "document" | "workspace"; id: string; title: string; canManage: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const userId = session?.user.id;

  const load = useCallback(async () => {
    if (!userId) return;
    const sb = supabase();
    const [p, w, wm, d, dm] = await Promise.all([
      sb.from("profiles").select("id,email,full_name").eq("id", userId).maybeSingle(),
      sb.from("workspaces").select("*").order("created_at"),
      sb.from("workspace_members").select("workspace_id, role").eq("user_id", userId),
      sb.from("documents").select("*").order("updated_at", { ascending: false }),
      sb.from("document_members").select("doc_id, role").eq("user_id", userId),
    ]);
    const err = [p, w, wm, d, dm].find((r) => r.error)?.error;
    if (err) return toast.error(errorMessage(err));
    setProfile(p.data as Profile);
    const list = (w.data as Workspace[]).sort((a, b) => Number(b.is_personal) - Number(a.is_personal));
    setWorkspaces(list);
    setWsRoles(Object.fromEntries((wm.data as { workspace_id: string; role: Role }[]).map((r) => [r.workspace_id, r.role])));
    setDocs(d.data as DocumentRec[]);
    setDocRoles(Object.fromEntries((dm.data as { doc_id: string; role: Role }[]).map((r) => [r.doc_id, r.role])));
    setView((v) => v ?? (list[0] ? { kind: "workspace", id: list[0].id } : { kind: "shared" }));
  }, [userId]);

  useEffect(() => {
    // Initial data fetch; state is set after the requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const wsIds = useMemo(() => new Set((workspaces ?? []).map((w) => w.id)), [workspaces]);
  const sharedDocs = docs.filter((d) => !wsIds.has(d.workspace_id));
  const currentWs = view?.kind === "workspace" ? workspaces?.find((w) => w.id === view.id) : undefined;
  const visibleDocs = view?.kind === "workspace" ? docs.filter((d) => d.workspace_id === view.id) : view?.kind === "shared" ? sharedDocs : [];
  const canCreate = currentWs ? ["owner", "editor"].includes(wsRoles[currentWs.id]) : false;
  const targetWsId = currentWs && canCreate ? currentWs.id : workspaces?.find((w) => w.is_personal)?.id;

  const docRole = (d: DocumentRec): Role | undefined => {
    const ranks: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
    const candidates = [docRoles[d.id], wsRoles[d.workspace_id]].filter(Boolean) as Role[];
    return candidates.sort((a, b) => ranks[b] - ranks[a])[0];
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const createFrom = (spec: typeof BLANK_DOC) =>
    run(async () => {
      if (!targetWsId) throw new Error("No workspace to create the document in");
      const id = await createDocument(targetWsId, spec);
      router.push(`/doc/${id}`);
    });

  const importFile = (file: File) =>
    run(async () => {
      if (!targetWsId) throw new Error("No workspace to create the document in");
      const tables = await parseImportFile(file);
      if (!tables.length) throw new Error("The file has no data");
      const id = await createDocument(targetWsId, { name: file.name.replace(/\.[^.]+$/, ""), tables });
      router.push(`/doc/${id}`);
    });

  const newWorkspace = async () => {
    const name = await prompt({ title: "New workspace", label: "Workspace name", confirmLabel: "Create" });
    if (!name) return;
    const { data, error } = await supabase().from("workspaces").insert({ name: name.trim(), owner_id: userId }).select().single();
    if (error) return toast.error(errorMessage(error));
    await load();
    setView({ kind: "workspace", id: data.id });
  };

  const renameWorkspace = async (ws: Workspace) => {
    const name = await prompt({ title: "Rename workspace", label: "Workspace name", initial: ws.name });
    if (!name) return;
    const { error } = await supabase().from("workspaces").update({ name: name.trim() }).eq("id", ws.id);
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const deleteWorkspace = async (ws: Workspace) => {
    const ok = await confirm({
      title: "Delete workspace?",
      message: `“${ws.name}” and all of its documents will be permanently deleted.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase().from("workspaces").delete().eq("id", ws.id);
    if (error) return toast.error(errorMessage(error));
    setView(null);
    void load();
  };

  const renameDoc = async (d: DocumentRec) => {
    const name = await prompt({ title: "Rename document", label: "Name", initial: d.name });
    if (!name) return;
    const { error } = await supabase().from("documents").update({ name: name.trim() }).eq("id", d.id);
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const moveDoc = async (d: DocumentRec, wsId: string) => {
    const { error } = await supabase().from("documents").update({ workspace_id: wsId }).eq("id", d.id);
    if (error) return toast.error(errorMessage(error));
    toast.success("Document moved");
    void load();
  };

  const deleteDoc = async (d: DocumentRec) => {
    const ok = await confirm({
      title: "Delete document?",
      message: `“${d.name}” will be permanently deleted for everyone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase().from("documents").delete().eq("id", d.id);
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  if (!session || !workspaces) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const displayName = profile?.full_name || profile?.email || session.user.email || "";

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="px-4 py-4">
          <Logo />
        </div>
        <div className="px-3">
          <Button variant="primary" className="w-full" onClick={(e) => setNewMenu(e.currentTarget)} disabled={busy}>
            <Plus size={16} /> New
          </Button>
        </div>
        <nav className="scroll-thin mt-4 flex-1 overflow-y-auto px-2">
          <div className="flex items-center justify-between px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
            Workspaces
            <IconButton title="New workspace" onClick={newWorkspace} className="h-6 w-6">
              <Plus size={14} />
            </IconButton>
          </div>
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setView({ kind: "workspace", id: ws.id })}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                view?.kind === "workspace" && view.id === ws.id ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
              )}
            >
              {ws.is_personal ? <FolderOpen size={16} /> : <Building2 size={16} />}
              <span className="flex-1 truncate">{ws.name}</span>
              <span className="text-xs text-gray-400">{docs.filter((d) => d.workspace_id === ws.id).length}</span>
            </button>
          ))}
          <div className="mt-4 border-t border-gray-100 pt-3">
            <button
              onClick={() => setView({ kind: "shared" })}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                view?.kind === "shared" ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
              )}
            >
              <Users size={16} /> <span className="flex-1">Shared with me</span>
              <span className="text-xs text-gray-400">{sharedDocs.length}</span>
            </button>
            <button
              onClick={() => setView({ kind: "templates" })}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                view?.kind === "templates" ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
              )}
            >
              <LayoutTemplate size={16} /> Templates
            </button>
          </div>
        </nav>
        <button onClick={(e) => setUserMenu(e.currentTarget)} className="flex items-center gap-2 border-t border-gray-100 px-4 py-3 text-left hover:bg-gray-50">
          <Avatar name={displayName} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{profile?.full_name || "Account"}</div>
            <div className="truncate text-xs text-gray-500">{profile?.email}</div>
          </div>
          <ChevronDown size={14} className="text-gray-400" />
        </button>
      </aside>

      <main className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          {view?.kind === "templates" ? (
            <>
              <h1 className="text-2xl font-semibold">Templates</h1>
              <p className="mt-1 text-sm text-gray-500">Start from a working example and adapt it.</p>
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    disabled={busy}
                    onClick={() => createFrom(t.spec)}
                    className="rounded-xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:border-brand-300 hover:shadow-md"
                  >
                    <LayoutTemplate className="mb-3 text-brand-600" size={22} />
                    <div className="font-medium">{t.name}</div>
                    <div className="mt-1 text-sm text-gray-500">{t.description}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <h1 className="flex-1 truncate text-2xl font-semibold">{currentWs ? currentWs.name : "Shared with me"}</h1>
                {currentWs && !currentWs.is_personal && (
                  <Button
                    onClick={() =>
                      setShare({ kind: "workspace", id: currentWs.id, title: currentWs.name, canManage: wsRoles[currentWs.id] === "owner" })
                    }
                  >
                    <Share2 size={15} /> Share
                  </Button>
                )}
                {currentWs && wsRoles[currentWs.id] === "owner" && (
                  <>
                    <IconButton title="Rename workspace" onClick={() => renameWorkspace(currentWs)}>
                      <Pencil size={15} />
                    </IconButton>
                    {!currentWs.is_personal && (
                      <IconButton title="Delete workspace" onClick={() => deleteWorkspace(currentWs)}>
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </>
                )}
              </div>
              {currentWs && canCreate && (
                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <QuickAction icon={<FilePlus2 size={20} />} title="Blank document" text="Start with an empty table" onClick={() => createFrom(BLANK_DOC)} disabled={busy} />
                  <QuickAction icon={<Upload size={20} />} title="Import a file" text="CSV or Excel (.xlsx)" onClick={() => fileInput.current?.click()} disabled={busy} />
                  <QuickAction icon={<LayoutTemplate size={20} />} title="Use a template" text="CRM, project tracker and more" onClick={() => setView({ kind: "templates" })} disabled={busy} />
                </div>
              )}
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-gray-400">Documents</h2>
              {visibleDocs.length === 0 ? (
                <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center text-sm text-gray-500">
                  {view?.kind === "shared" ? "Nothing has been shared with you yet." : "No documents here yet."}
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleDocs.map((d) => (
                    <div key={d.id} className="group relative rounded-xl border border-gray-200 bg-white shadow-sm transition hover:border-brand-300 hover:shadow-md">
                      <Link href={`/doc/${d.id}`} className="block p-4">
                        <FileSpreadsheet className="mb-3 text-brand-600" size={22} />
                        <div className="truncate pr-8 font-medium">{d.name}</div>
                        <div className="mt-1 text-xs text-gray-500">
                          Edited {timeAgo(d.updated_at)} · <span className="capitalize">{docRole(d)}</span>
                        </div>
                      </Link>
                      <IconButton
                        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100"
                        onClick={(e) => setDocMenu({ el: e.currentTarget, doc: d })}
                        title="Document options"
                      >
                        <MoreHorizontal size={16} />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xlsm"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f);
        }}
      />

      <Popover anchor={newMenu} onClose={() => setNewMenu(null)}>
        <MenuItem icon={<FilePlus2 size={15} />} onClick={() => (setNewMenu(null), createFrom(BLANK_DOC))}>
          Blank document
        </MenuItem>
        <MenuItem icon={<Upload size={15} />} onClick={() => (setNewMenu(null), fileInput.current?.click())}>
          Import CSV / Excel
        </MenuItem>
        <MenuItem icon={<LayoutTemplate size={15} />} onClick={() => (setNewMenu(null), setView({ kind: "templates" }))}>
          From template
        </MenuItem>
        <MenuDivider />
        <MenuItem icon={<Building2 size={15} />} onClick={() => (setNewMenu(null), newWorkspace())}>
          Workspace
        </MenuItem>
      </Popover>

      <Popover anchor={docMenu?.el ?? null} onClose={() => setDocMenu(null)} align="end">
        {docMenu && (
          <>
            <MenuItem icon={<FolderOpen size={15} />} onClick={() => router.push(`/doc/${docMenu.doc.id}`)}>
              Open
            </MenuItem>
            <MenuItem
              icon={<Pencil size={15} />}
              disabled={!["owner", "editor"].includes(docRole(docMenu.doc) ?? "")}
              onClick={() => (setDocMenu(null), renameDoc(docMenu.doc))}
            >
              Rename
            </MenuItem>
            <MenuItem
              icon={<Share2 size={15} />}
              onClick={() => {
                setShare({ kind: "document", id: docMenu.doc.id, title: docMenu.doc.name, canManage: docRole(docMenu.doc) === "owner" });
                setDocMenu(null);
              }}
            >
              Share
            </MenuItem>
            {docRole(docMenu.doc) === "owner" &&
              workspaces
                .filter((w) => w.id !== docMenu.doc.workspace_id && ["owner", "editor"].includes(wsRoles[w.id]))
                .map((w) => (
                  <MenuItem key={w.id} icon={<FolderOpen size={15} />} onClick={() => (setDocMenu(null), moveDoc(docMenu.doc, w.id))}>
                    Move to {w.name}
                  </MenuItem>
                ))}
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={15} />}
              danger
              disabled={docRole(docMenu.doc) !== "owner"}
              onClick={() => (setDocMenu(null), deleteDoc(docMenu.doc))}
            >
              Delete
            </MenuItem>
          </>
        )}
      </Popover>

      <Popover anchor={userMenu} onClose={() => setUserMenu(null)}>
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

      {share && userId && (
        <ShareDialog
          open
          onClose={() => setShare(null)}
          kind={share.kind}
          targetId={share.id}
          title={share.title}
          canManage={share.canManage}
          currentUserId={userId}
        />
      )}
      {busy && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-white/60">
          <Spinner className="h-8 w-8" />
        </div>
      )}
    </div>
  );
}

function QuickAction({ icon, title, text, onClick, disabled }: { icon: React.ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow-md"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-gray-500">{text}</span>
      </span>
    </button>
  );
}
