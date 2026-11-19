"use client";

// Documents, Shared with me and Trash, inside the workspace's sidebar layout:
// /w/<ws>/documents, /w/<ws>/shared, /w/<ws>/trash.
import clsx from "clsx";
import { Copy, FilePlus2, FileSpreadsheet, FolderOpen, Loader2, MoreHorizontal, Pencil, Share2, Trash2, Undo2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyDialog } from "@/components/CopyDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { Button, IconButton, MenuDivider, MenuItem, Popover, useDialogs } from "@/components/ui";
import { bestRole, type AppData } from "@/lib/appData";
import { BLANK_DOC, createDocument, parseImportFile } from "@/lib/docBuilder";
import { errorMessage, supabase } from "@/lib/supabase";
import type { DocumentRec, Role } from "@/lib/types";
import { toast } from "@/store/toasts";

export type DocsMode = "documents" | "shared" | "trash";

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function Action({ icon, title, text, onClick, disabled }: { icon: React.ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow-md disabled:opacity-50">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-gray-500">{text}</span>
      </span>
    </button>
  );
}

export function DocumentsView({ wsId, mode, app, userId }: { wsId: string; mode: DocsMode; app: AppData; userId: string }) {
  const router = useRouter();
  const { confirm, prompt } = useDialogs();
  const [docs, setDocs] = useState<DocumentRec[] | null>(null);
  const [docRoles, setDocRoles] = useState<Record<string, Role>>({});
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ el: HTMLElement; doc: DocumentRec } | null>(null);
  const [share, setShare] = useState<DocumentRec | null>(null);
  const [copyOf, setCopyOf] = useState<DocumentRec | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [d, dm] = await Promise.all([
      sb.from("documents").select("*").neq("kind", "hub").order("updated_at", { ascending: false }),
      sb.from("document_members").select("doc_id, role").eq("user_id", userId),
    ]);
    if (d.error) return toast.error(errorMessage(d.error));
    setDocs(d.data as DocumentRec[]);
    setDocRoles(Object.fromEntries(((dm.data as { doc_id: string; role: Role }[] | null) ?? []).map((r) => [r.doc_id, r.role])));
  }, [userId]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const ws = app.workspaces.find((w) => w.id === wsId);
  const myWs = new Set(app.workspaces.map((w) => w.id));
  const canCreate = ["owner", "editor"].includes(app.wsRole(ws) ?? "");
  const docRole = (d: DocumentRec) => bestRole(docRoles[d.id], app.wsRole(app.workspaces.find((w) => w.id === d.workspace_id)));
  const live = (docs ?? []).filter((d) => !d.deleted_at);
  const shown = mode === "documents" ? live.filter((d) => d.workspace_id === wsId) : mode === "shared" ? live.filter((d) => !myWs.has(d.workspace_id)) : (docs ?? []).filter((d) => d.deleted_at);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  };
  const newDoc = () => run(async () => router.push(`/doc/${await createDocument(wsId, BLANK_DOC)}`));
  const importFile = (file: File) =>
    run(async () => {
      // A backup file becomes a new document with everything in it.
      if (/\.json$/i.test(file.name)) {
        if (file.size > 100 * 1024 * 1024) throw new Error("Backup files can be up to 100 MB");
        let backup: { format?: string; name?: string };
        try {
          backup = JSON.parse(await file.text());
        } catch {
          throw new Error("That file isn't a backup (it isn't valid JSON)");
        }
        if (backup?.format !== "lmdu-backup") throw new Error("That file isn't an LM Data Universe backup");
        const { data, error } = await supabase().rpc("restore_backup", { p_workspace: wsId, p_name: `${backup.name ?? "Document"} (restored)`, p_backup: backup });
        if (error) throw error;
        router.push(`/doc/${data as string}`);
        return;
      }
      const tables = await parseImportFile(file);
      if (!tables.length) throw new Error("The file has no data");
      router.push(`/doc/${await createDocument(wsId, { name: file.name.replace(/\.[^.]+$/, ""), tables })}`);
    });

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) => {
    const { error } = await fn();
    if (error) return toast.error(errorMessage(error));
    if (ok) toast.success(ok);
    void load();
  };
  const rename = async (d: DocumentRec) => {
    const name = await prompt({ title: "Rename document", label: "Name", initial: d.name });
    if (name) await act(() => supabase().from("documents").update({ name: name.trim() }).eq("id", d.id));
  };
  const deleteForever = async (d: DocumentRec) => {
    const ok = await confirm({ title: "Delete forever?", message: `“${d.name}”, its history and its snapshots will be deleted for everyone. This can't be undone.`, confirmLabel: "Delete forever", danger: true });
    if (ok) await act(() => supabase().rpc("delete_document_forever", { p_doc: d.id }));
  };

  const title = mode === "documents" ? "Documents" : mode === "shared" ? "Shared with me" : "Trash";
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {mode === "documents"
            ? `Spreadsheets and data documents in ${ws?.name ?? "this workspace"}.`
            : mode === "shared"
              ? "Documents other people shared with you directly."
              : "Deleted documents stay here for 30 days. Owners can restore them or delete them for good."}
        </p>

        {mode === "documents" && canCreate && (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Action icon={<FilePlus2 size={20} />} title="New document" text="Start with an empty table" onClick={() => void newDoc()} disabled={busy} />
            <Action icon={<Upload size={20} />} title="Import a file" text="CSV, Excel or a backup file" onClick={() => fileInput.current?.click()} disabled={busy} />
          </div>
        )}

        {!docs ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : shown.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center text-sm text-gray-500">
            {mode === "shared" ? "Nothing has been shared with you yet." : mode === "trash" ? "The trash is empty." : "No documents here yet."}
          </div>
        ) : mode === "trash" ? (
          <ul className="mt-6 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {shown.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                <FileSpreadsheet className="text-gray-400" size={18} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="text-xs text-gray-500">
                    Deleted {timeAgo(d.deleted_at!)} · gone for good {new Date(new Date(d.deleted_at!).getTime() + 30 * 86400000).toLocaleDateString()}
                  </div>
                </div>
                {docRole(d) === "owner" ? (
                  <>
                    <Button size="sm" onClick={() => void act(() => supabase().rpc("restore_document", { p_doc: d.id }), `“${d.name}” restored`)}>
                      <Undo2 size={14} /> Restore
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => void deleteForever(d)}>
                      Delete forever
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-gray-400">Only owners can restore</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((d) => (
              <div key={d.id} className="group relative rounded-xl border border-gray-200 bg-white shadow-sm transition hover:border-brand-300 hover:shadow-md">
                <Link href={`/doc/${d.id}`} className="block p-4">
                  <FileSpreadsheet className="mb-3 text-brand-600" size={22} />
                  <div className="truncate pr-8 font-medium">{d.name}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    Edited {timeAgo(d.updated_at)} · <span className="capitalize">{docRole(d)}</span>
                  </div>
                </Link>
                <IconButton className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={(e) => setMenu({ el: e.currentTarget, doc: d })} title="Document options">
                  <MoreHorizontal size={16} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xlsm,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f);
        }}
      />

      <Popover anchor={menu?.el ?? null} onClose={() => setMenu(null)} align="end">
        {menu && (
          <>
            <MenuItem icon={<FolderOpen size={15} />} onClick={() => router.push(`/doc/${menu.doc.id}`)}>
              Open
            </MenuItem>
            <MenuItem icon={<Pencil size={15} />} disabled={!["owner", "editor"].includes(docRole(menu.doc) ?? "")} onClick={() => (setMenu(null), void rename(menu.doc))}>
              Rename
            </MenuItem>
            <MenuItem icon={<Share2 size={15} />} onClick={() => (setShare(menu.doc), setMenu(null))}>
              Share
            </MenuItem>
            {docRole(menu.doc) === "owner" &&
              app.workspaces
                .filter((w) => w.id !== menu.doc.workspace_id && ["owner", "editor"].includes(app.wsRole(w) ?? ""))
                .map((w) => (
                  <MenuItem key={w.id} icon={<FolderOpen size={15} />} onClick={() => (setMenu(null), void act(() => supabase().from("documents").update({ workspace_id: w.id }).eq("id", menu.doc.id), "Document moved"))}>
                    Move to {w.name}
                  </MenuItem>
                ))}
            <MenuItem icon={<Copy size={15} />} onClick={() => (setCopyOf(menu.doc), setMenu(null))}>
              Duplicate…
            </MenuItem>
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={15} />}
              danger
              disabled={docRole(menu.doc) !== "owner"}
              onClick={() => (setMenu(null), void act(() => supabase().rpc("trash_document", { p_doc: menu.doc.id }), `“${menu.doc.name}” moved to the trash. It's deleted for good after 30 days.`))}
            >
              Move to trash
            </MenuItem>
          </>
        )}
      </Popover>

      {copyOf && <CopyDialog docId={copyOf.id} docName={copyOf.name} defaultWorkspace={copyOf.workspace_id} onClose={() => (setCopyOf(null), void load())} />}
      {share && <ShareDialog open onClose={() => setShare(null)} kind="document" targetId={share.id} title={share.name} canManage={docRole(share) === "owner"} currentUserId={userId} />}
      {busy && (
        <div className={clsx("fixed inset-0 z-40 flex items-center justify-center bg-white/60")}>
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      )}
    </div>
  );
}
