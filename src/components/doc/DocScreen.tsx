"use client";

import clsx from "clsx";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  FileText,
  LayoutPanelLeft,
  MoreHorizontal,
  Pencil,
  Plus,
  Redo2,
  Search,
  Share2,
  ShieldCheck,
  Eye,
  Sigma,
  MessageSquare,
  History,
  Copy,
  GitBranch,
  Trash2,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Logo } from "@/components/Logo";
import { ShareDialog } from "@/components/ShareDialog";
import { Button, IconButton, MenuDivider, MenuItem, Popover, Spinner, useDialogs } from "@/components/ui";
import { AddWidgetDialog } from "./AddWidgetDialog";
import { RawDataView } from "./RawDataView";
import { AccessRulesView } from "./AccessRules";
import { RightPanel } from "./RightPanel";
import { RecordCardModal } from "./RecordCard";
import { WidgetFrame } from "./WidgetFrame";
import { exportDocXlsx } from "@/lib/exporter";
import { useLinkVisitor, useRequireSession, useSession } from "@/lib/session";
import { useDoc, type SaveState } from "@/store/docStore";
import { useUi, withDraft } from "@/store/uiStore";
import { joinPresence, leavePresence, usePresence, type Peer } from "@/store/presence";
import { useComments } from "@/store/comments";
import { CellCommentsPopover } from "./Comments";
import { CompareDialog } from "./History";
import { CopyDialog } from "@/components/CopyDialog";
import { diffContents, type DocContent } from "@/lib/compare";
import { errorMessage, supabase } from "@/lib/supabase";
import { toast } from "@/store/toasts";
import { useRouter, useSearchParams } from "next/navigation";
import { filterText, visibleColumns, widgetRows } from "@/lib/view";
import type { DocWidget } from "@/lib/types";

export function DocScreen({ docId }: { docId: string }) {
  const rawSession = useSession();
  useRequireSession({ allowShareLink: true });
  // Signed-out visitors holding a share link can open the document too.
  const linkVisitor = useLinkVisitor(rawSession);
  const session = rawSession ?? null;
  const loading = useDoc((s) => s.loading);
  const error = useDoc((s) => s.error);
  const doc = useDoc((s) => s.doc);
  const role = useDoc((s) => s.role);
  const pages = useDoc((s) => s.pages);
  const widgets = useDoc((s) => s.widgets);
  const canUndo = useDoc((s) => s.canUndo);
  const canRedo = useDoc((s) => s.canRedo);
  const saveState = useDoc((s) => s.saveState);
  const activePage = useUi((s) => s.activePage);
  const setActivePage = useUi((s) => s.setActivePage);
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const panel = useUi((s) => s.panel);
  const openPanel = useUi((s) => s.openPanel);
  const { confirm, prompt } = useDialogs();
  const [dialog, setDialog] = useState<"page" | "widget" | null>(null);
  const [pageMenu, setPageMenu] = useState<{ el: HTMLElement; id: string } | null>(null);
  const [exportMenu, setExportMenu] = useState<HTMLElement | null>(null);
  const [sharing, setSharing] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const viewAs = useDoc((s) => s.viewAs);
  const acl = useDoc((s) => s.acl);
  const canEdit = (role === "owner" || role === "editor") && !viewAs;
  // Access rules: copies hold everything, so with rules (or when blocked) only owners may copy.
  const copyBlocked = role !== "owner" && (!!acl?.ruled || !!acl?.settings.block_copies);
  const downloadBlocked = role !== "owner" && !!acl?.settings.block_copies;
  const showAccessRules = !!session && (role === "owner" || !!acl?.settings.public_rules);

  // Keyed on the user id, not the session object: the session is replaced on
  // every token refresh, which must not reload the document.
  const userId = session?.user.id ?? (linkVisitor ? "link-visitor" : undefined);
  // ?snapshot=<id> shows that snapshot read-only instead of the live document.
  const searchParams = useSearchParams();
  const snapshotParam = Number(searchParams.get("snapshot")) || null;
  useEffect(() => {
    if (!userId) return;
    if (snapshotParam) void useDoc.getState().loadSnapshot(docId, snapshotParam);
    else void useDoc.getState().load(docId);
    useUi.setState({ activePage: null, activeWidget: null, panel: snapshotParam ? { tab: "history" } : null, search: "", rawTable: null });
    return () => useDoc.getState().unload();
  }, [docId, userId, snapshotParam]);
  const snapshot = useDoc((s) => s.snapshot);
  const [copyDialog, setCopyDialog] = useState<"copy" | "fork" | null>(null);
  const [docMenu, setDocMenu] = useState<HTMLElement | null>(null);
  const [comparing, setComparing] = useState(false);
  const [original, setOriginal] = useState<{ id: string; name: string } | null>(null);
  const forkedFrom = useDoc((s) => s.doc?.forked_from ?? null);
  useEffect(() => {
    if (!forkedFrom) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOriginal(null);
      return;
    }
    void supabase()
      .from("documents")
      .select("id,name")
      .eq("id", forkedFrom)
      .maybeSingle()
      .then(({ data }) => setOriginal(data ? { id: data.id, name: data.name } : null));
  }, [forkedFrom]);

  // Default to the first page; fall back when the active page disappears.
  useEffect(() => {
    if (activePage === "raw" || activePage === "access") return;
    if (!activePage || !pages.some((p) => p.id === activePage)) {
      setActivePage(pages[0]?.id ?? (doc ? "raw" : null));
    }
  }, [pages, activePage, setActivePage, doc]);

  useEffect(() => {
    if (doc) document.title = `${doc.name} · LM Data Universe`;
  }, [doc]);

  // Presence: tell collaborators we're here (and which cell we're on).
  const me = useDoc((s) => s.me);
  const docLoaded = !!doc && !loading;
  useEffect(() => {
    if (!docLoaded) return;
    joinPresence(docId, { userId: me?.UserID ?? null, name: me?.Name || me?.Email || "Guest" });
    return () => leavePresence();
  }, [docLoaded, docId, me?.UserID, me?.Name, me?.Email]);
  const peers = usePresence((s) => s.peers);

  // Comments: load with the document; ?comment=<id> (from a mention email) opens its thread.
  useEffect(() => {
    if (!docLoaded) return;
    void useComments
      .getState()
      .load(docId)
      .then(() => {
        const id = new URLSearchParams(window.location.search).get("comment");
        const c = id ? useComments.getState().comments.get(id) : undefined;
        if (c) useUi.getState().openPanel({ tab: "comments" });
      });
    return () => useComments.getState().unload();
  }, [docLoaded, docId]);
  const openCommentCount = useComments((s) => [...s.comments.values()].filter((c) => !c.parent_id && !c.resolved).length);

  // Undo/redo shortcuts outside of text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void useDoc.getState().undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        void useDoc.getState().redo();
      } else if (k === "f") {
        e.preventDefault();
        document.getElementById("doc-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pageWidgets = useMemo(
    () => [...widgets.values()].filter((w) => w.page_id === activePage).sort((a, b) => a.position - b.position),
    [widgets, activePage],
  );

  if ((!session && !linkVisitor) || (loading && !doc)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-gray-600">{error ?? "Document not found."}</p>
        <Link href="/">
          <Button>
            <ArrowLeft size={14} /> Back to documents
          </Button>
        </Link>
      </div>
    );
  }

  const currentPage = pages.find((p) => p.id === activePage);

  return (
    <div className="flex h-full flex-col">
      {/* top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-3">
        <Link href="/" title="All documents" className="rounded-md p-1 hover:bg-gray-100">
          <Logo compact />
        </Link>
        {editingName && canEdit ? (
          <input
            autoFocus
            defaultValue={doc.name}
            onBlur={(e) => {
              setEditingName(false);
              if (e.target.value.trim() && e.target.value !== doc.name) void useDoc.getState().renameDoc(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingName(false);
            }}
            className="h-8 w-72 rounded-md border border-brand-400 px-2 text-sm font-semibold outline-none ring-2 ring-brand-100"
          />
        ) : (
          <button
            onClick={() => canEdit && setEditingName(true)}
            className={clsx("max-w-80 truncate rounded-md px-2 py-1 text-sm font-semibold", canEdit && "hover:bg-gray-100")}
          >
            {doc.name}
          </button>
        )}
        {role === "viewer" && !viewAs && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">View only</span>}
        <div className="flex items-center">
          <IconButton title="Undo (Ctrl+Z)" disabled={!canUndo || !canEdit} onClick={() => useDoc.getState().undo()}>
            <Undo2 size={16} />
          </IconButton>
          <IconButton title="Redo (Ctrl+Y)" disabled={!canRedo || !canEdit} onClick={() => useDoc.getState().redo()}>
            <Redo2 size={16} />
          </IconButton>
        </div>
        {canEdit && <SaveIndicator state={saveState} />}
        <PeerAvatars peers={peers} />
        <div className="flex-1" />
        <FindBar search={search} setSearch={setSearch} widgets={pageWidgets} />
        {canEdit && currentPage && (
          <Button size="sm" onClick={() => setDialog("widget")}>
            <Plus size={14} /> Add widget
          </Button>
        )}
        {!downloadBlocked && (
          <Button size="sm" variant="ghost" onClick={(e) => setExportMenu(e.currentTarget)}>
            <Download size={14} /> Export
          </Button>
        )}
        {session ? (
          <Button size="sm" variant="primary" onClick={() => setSharing(true)}>
            <Share2 size={14} /> Share
          </Button>
        ) : (
          <Link href={`/login?next=${encodeURIComponent(`/doc/${docId}`)}`}>
            <Button size="sm" variant="primary">Sign in</Button>
          </Link>
        )}
        <IconButton title="Document menu" onClick={(e) => setDocMenu(e.currentTarget)}>
          <MoreHorizontal size={16} />
        </IconButton>
        <IconButton title="Comments" onClick={() => openPanel(panel?.tab === "comments" ? null : { tab: "comments" })} className="relative">
          <MessageSquare size={16} />
          {openCommentCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-amber-500 px-1 text-[9px] font-semibold leading-[14px] text-white">{openCommentCount}</span>
          )}
        </IconButton>
        <IconButton title="History and snapshots" onClick={() => openPanel(panel?.tab === "history" ? null : { tab: "history" })}>
          <History size={16} />
        </IconButton>
        <IconButton title="All formulas in this document" onClick={() => openPanel(panel?.tab === "formulas" ? null : { tab: "formulas" })}>
          <Sigma size={16} />
        </IconButton>
        <IconButton title="Toggle settings panel" onClick={() => openPanel(panel ? null : pageWidgets[0] ? { tab: "widget", widgetId: pageWidgets[0].id } : null)}>
          <LayoutPanelLeft size={16} className="rotate-180" />
        </IconButton>
      </header>

      {viewAs && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <Eye size={15} />
          <span className="flex-1">
            Viewing as <strong>{viewAs}</strong>
            {acl?.access ? ` (${acl.access})` : ""}: what they can see with the saved access rules. Read-only.
          </span>
          <Button size="sm" onClick={() => void useDoc.getState().setViewAs(null)}>
            Back to my view
          </Button>
        </div>
      )}

      <DocBanners
        snapshot={snapshot}
        original={original}
        onCompare={() => setComparing(true)}
        onReplaced={() => void useDoc.getState().load(docId)}
      />

      <div className="flex min-h-0 flex-1">
        {/* pages */}
        <nav className="scroll-thin flex w-56 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white px-2 py-3">
          <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Pages</div>
          {pages.map((p) => (
            <div
              key={p.id}
              className={clsx(
                "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                activePage === p.id ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
              )}
            >
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setActivePage(p.id)}>
                <FileText size={15} className="shrink-0 opacity-60" />
                <span className="truncate">{p.name}</span>
              </button>
              {canEdit && (
                <button className="rounded p-0.5 opacity-0 hover:bg-gray-200 group-hover:opacity-100" onClick={(e) => setPageMenu({ el: e.currentTarget, id: p.id })}>
                  <MoreHorizontal size={14} />
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button onClick={() => setDialog("page")} className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-brand-600 hover:bg-brand-50">
              <Plus size={15} /> Add new page
            </button>
          )}
          <div className="mt-4 border-t border-gray-100 pt-3">
            <button
              onClick={() => setActivePage("raw")}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                activePage === "raw" ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
              )}
            >
              <Database size={15} className="opacity-60" /> Raw data
            </button>
            {showAccessRules && (
              <button
                onClick={() => setActivePage("access")}
                className={clsx(
                  "mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  activePage === "access" ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100",
                )}
              >
                <ShieldCheck size={15} className="opacity-60" /> Access rules
                {acl?.ruled && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-500" title="This document has access rules" />}
              </button>
            )}
          </div>
        </nav>

        {/* content */}
        <main className="scroll-thin min-w-0 flex-1 overflow-auto bg-gray-50 p-4">
          {activePage === "raw" ? (
            <ErrorBoundary label="Raw data couldn't be displayed">
              <RawDataView />
            </ErrorBoundary>
          ) : activePage === "access" && showAccessRules ? (
            <ErrorBoundary label="Access rules couldn't be displayed">
              <AccessRulesView />
            </ErrorBoundary>
          ) : currentPage ? (
            pageWidgets.length ? (
              <div className="grid grid-cols-12 gap-4">
                {pageWidgets.map((w) => (
                  <WidgetFrame key={w.id} widget={w} siblings={pageWidgets} />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
                This page is empty.{" "}
                {canEdit && (
                  <button className="font-medium text-brand-600 hover:underline" onClick={() => setDialog("widget")}>
                    Add a widget
                  </button>
                )}
              </div>
            )
          ) : (
            <div className="p-10 text-center text-sm text-gray-500">No pages yet.</div>
          )}
        </main>

        <ErrorBoundary label="Settings panel couldn't be displayed">
          <RightPanel />
        </ErrorBoundary>
      </div>

      {dialog && <AddWidgetDialog mode={dialog} onClose={() => setDialog(null)} />}

      <Popover anchor={pageMenu?.el ?? null} onClose={() => setPageMenu(null)} align="end">
        {pageMenu && (
          <>
            <MenuItem
              icon={<Pencil size={14} />}
              onClick={async () => {
                const p = pages.find((x) => x.id === pageMenu.id);
                setPageMenu(null);
                const name = await prompt({ title: "Rename page", label: "Page name", initial: p?.name });
                if (name) await useDoc.getState().renamePage(pageMenu.id, name);
              }}
            >
              Rename
            </MenuItem>
            <MenuItem icon={<ChevronUp size={14} />} onClick={() => (useDoc.getState().movePage(pageMenu.id, -1), setPageMenu(null))}>
              Move up
            </MenuItem>
            <MenuItem icon={<ChevronDown size={14} />} onClick={() => (useDoc.getState().movePage(pageMenu.id, 1), setPageMenu(null))}>
              Move down
            </MenuItem>
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={14} />}
              danger
              onClick={async () => {
                const id = pageMenu.id;
                setPageMenu(null);
                const ok = await confirm({
                  title: "Remove page?",
                  message: "The page and its widgets are removed. Tables and data stay available under Raw data.",
                  confirmLabel: "Remove page",
                  danger: true,
                });
                if (ok) await useDoc.getState().deletePage(id);
              }}
            >
              Remove page
            </MenuItem>
          </>
        )}
      </Popover>

      <Popover anchor={exportMenu} onClose={() => setExportMenu(null)} align="end">
        <MenuItem icon={<Download size={14} />} onClick={() => (exportDocXlsx(), setExportMenu(null))}>
          Whole document as Excel (.xlsx)
        </MenuItem>
        <p className="px-3 py-1.5 text-xs text-gray-400">For CSV, use a widget&apos;s ⋯ menu.</p>
      </Popover>

      <RecordCardModal />
      <CellCommentsPopover />
      <Popover anchor={docMenu} onClose={() => setDocMenu(null)} align="end">
        <MenuItem icon={<Copy size={14} />} disabled={!session || copyBlocked} onClick={() => (setDocMenu(null), setCopyDialog("copy"))}>
          Save a copy…
        </MenuItem>
        <MenuItem icon={<GitBranch size={14} />} disabled={!session || copyBlocked} onClick={() => (setDocMenu(null), setCopyDialog("fork"))}>
          Work on a copy…
        </MenuItem>
        {copyBlocked && <p className="px-3 py-1.5 text-xs text-gray-400">Only owners can copy this document.</p>}
        <MenuDivider />
        <MenuItem icon={<History size={14} />} onClick={() => (setDocMenu(null), openPanel({ tab: "history" }))}>
          History and snapshots
        </MenuItem>
        <MenuItem icon={<MessageSquare size={14} />} onClick={() => (setDocMenu(null), openPanel({ tab: "comments" }))}>
          Comments
        </MenuItem>
        {!session && <p className="px-3 py-1.5 text-xs text-gray-400">Sign in to save a copy.</p>}
      </Popover>
      {copyDialog && (
        <CopyDialog docId={docId} docName={doc.name} defaultWorkspace={doc.workspace_id} fork={copyDialog === "fork"} onClose={() => setCopyDialog(null)} />
      )}
      {comparing && original && (
        <CompareDialog
          title={`“${original.name}” (original) → this copy`}
          load={async () => {
            const [a, b] = await Promise.all([supabase().rpc("doc_content", { p_doc: original.id }), supabase().rpc("doc_content", { p_doc: docId })]);
            if (a.error) throw a.error;
            if (b.error) throw b.error;
            return diffContents(a.data as DocContent, b.data as DocContent, { byName: true });
          }}
          onClose={() => setComparing(false)}
        />
      )}
      {sharing && (
        <ShareDialog
          open
          onClose={() => setSharing(false)}
          kind="document"
          targetId={doc.id}
          title={doc.name}
          canManage={role === "owner"}
          currentUserId={session?.user.id ?? ""}
        />
      )}
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text = state === "saving" ? "Saving…" : state === "error" ? "Couldn't save, reloaded" : "All changes saved";
  return (
    <span
      role="status"
      aria-live="polite"
      className={clsx("text-xs", state === "error" ? "text-red-600" : "text-gray-400")}
    >
      {text}
    </span>
  );
}

/** Find across the tables of the page: Enter / Shift+Enter (or the arrows) move between matches. */
function FindBar({ search, setSearch, widgets }: { search: string; setSearch: (s: string) => void; widgets: DocWidget[] }) {
  const version = useDoc((s) => s.version);
  const drafts = useUi((s) => s.drafts);
  const findTarget = useUi((s) => s.findTarget);
  const q = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    const out: { widgetId: string; rowId: number; colId: string }[] = [];
    for (const saved of widgets) {
      if (saved.type !== "table" || !saved.table_ref) continue;
      const w = withDraft(saved, drafts[saved.id]);
      const cols = visibleColumns(w);
      for (const rowId of widgetRows(w).ids) {
        for (const c of cols) {
          if (filterText(c, rowId).toLowerCase().includes(q)) out.push({ widgetId: w.id, rowId, colId: c.id });
          if (out.length >= 5000) return out;
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, widgets, drafts, version]);
  const current = findTarget
    ? matches.findIndex((m) => m.widgetId === findTarget.widgetId && m.rowId === findTarget.rowId && m.colId === findTarget.colId)
    : -1;
  const go = (delta: number) => {
    if (!matches.length) return;
    const i = current < 0 ? (delta > 0 ? 0 : matches.length - 1) : (current + delta + matches.length) % matches.length;
    useUi.getState().setActiveWidget(matches[i].widgetId);
    useUi.getState().setFindTarget(matches[i]);
  };
  return (
    <div className="relative flex items-center">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        id="doc-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") setSearch("");
        }}
        placeholder="Find in page (Ctrl+F)"
        className="h-8 w-64 rounded-md border border-gray-200 bg-gray-50 pl-8 pr-24 text-sm outline-none focus:border-brand-400 focus:bg-white"
      />
      {q && (
        <div className="absolute right-1 flex items-center gap-0.5">
          <span className="px-1 text-[11px] text-gray-500">{matches.length ? `${current < 0 ? 0 : current + 1}/${matches.length}${matches.length >= 5000 ? "+" : ""}` : "0"}</span>
          <IconButton title="Previous match (Shift+Enter)" onClick={() => go(-1)} disabled={!matches.length}>
            <ChevronUp size={14} />
          </IconButton>
          <IconButton title="Next match (Enter)" onClick={() => go(1)} disabled={!matches.length}>
            <ChevronDown size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** People with this document open (one avatar per person). */
function PeerAvatars({ peers }: { peers: Peer[] }) {
  const byPerson = new Map<string, Peer>();
  for (const p of peers) byPerson.set(p.userId ?? p.key, p);
  const list = [...byPerson.values()];
  if (!list.length) return null;
  return (
    <div className="flex items-center -space-x-1.5" title={`Also here: ${list.map((p) => p.name).join(", ")}`}>
      {list.slice(0, 5).map((p) => (
        <span
          key={p.key}
          className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white"
          style={{ background: p.color }}
        >
          {(p.name.trim()[0] ?? "?").toUpperCase()}
        </span>
      ))}
      {list.length > 5 && <span className="pl-2 text-xs text-gray-500">+{list.length - 5}</span>}
    </div>
  );
}

/** Read-only snapshot, document in the trash, or a working copy of another document. */
function DocBanners({
  snapshot,
  original,
  onCompare,
  onReplaced,
}: {
  snapshot: { id: number; label: string | null; created_at: string; realRole: string | null } | null;
  original: { id: string; name: string } | null;
  onCompare: () => void;
  onReplaced: () => void;
}) {
  const doc = useDoc((s) => s.doc);
  const role = useDoc((s) => s.role);
  const router = useRouter();
  const { confirm } = useDialogs();
  if (!doc) return null;
  if (snapshot) {
    return (
      <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        <span className="flex-1">
          Viewing a snapshot from <b>{new Date(snapshot.created_at).toLocaleString()}</b>
          {snapshot.label ? ` (“${snapshot.label}”)` : ""}. It&apos;s read-only.
        </span>
        <Button size="sm" onClick={() => router.push(`/doc/${doc.id}`)}>
          Back to the current version
        </Button>
      </div>
    );
  }
  if (doc.deleted_at) {
    return (
      <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900">
        <span className="flex-1">This document is in the trash and can&apos;t be edited. It&apos;s deleted for good 30 days after it was removed.</span>
        {role === "owner" && (
          <Button
            size="sm"
            onClick={async () => {
              const { error } = await supabase().rpc("restore_document", { p_doc: doc.id });
              if (error) return toast.error(errorMessage(error));
              toast.success("Document restored");
              void useDoc.getState().load(doc.id);
            }}
          >
            Restore
          </Button>
        )}
      </div>
    );
  }
  if (doc.forked_from && original) {
    return (
      <div className="flex items-center gap-3 border-b border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-900">
        <span className="flex-1">
          This is a working copy of <Link href={`/doc/${original.id}`} className="font-medium underline">{original.name}</Link>. Changes here don&apos;t affect the original.
        </span>
        <Button size="sm" onClick={onCompare}>
          Compare with original
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            const ok = await confirm({
              title: `Replace “${original.name}” with this copy?`,
              message: "The original gets this copy's content. A snapshot of the original is saved first, so it can be restored. Only owners of the original can do this.",
              confirmLabel: "Replace original",
              danger: true,
            });
            if (!ok) return;
            const { error } = await supabase().rpc("replace_with_copy", { p_copy: doc.id });
            if (error) return toast.error(errorMessage(error));
            toast.success("Original replaced");
            onReplaced();
            router.push(`/doc/${original.id}`);
          }}
        >
          Replace original
        </Button>
      </div>
    );
  }
  return null;
}
