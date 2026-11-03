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
  Trash2,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/Logo";
import { ShareDialog } from "@/components/ShareDialog";
import { Button, IconButton, MenuDivider, MenuItem, Popover, Spinner, useDialogs } from "@/components/ui";
import { AddWidgetDialog } from "./AddWidgetDialog";
import { RawDataView } from "./RawDataView";
import { RightPanel } from "./RightPanel";
import { WidgetFrame } from "./WidgetFrame";
import { exportDocXlsx } from "@/lib/exporter";
import { useRequireSession } from "@/lib/session";
import { useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

export function DocScreen({ docId }: { docId: string }) {
  const session = useRequireSession();
  const loading = useDoc((s) => s.loading);
  const error = useDoc((s) => s.error);
  const doc = useDoc((s) => s.doc);
  const role = useDoc((s) => s.role);
  const pages = useDoc((s) => s.pages);
  const widgets = useDoc((s) => s.widgets);
  const undoCount = useDoc((s) => s.undoStack.length);
  const redoCount = useDoc((s) => s.redoStack.length);
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
  const canEdit = role === "owner" || role === "editor";

  useEffect(() => {
    if (!session) return;
    void useDoc.getState().load(docId);
    useUi.setState({ activePage: null, activeWidget: null, panel: null, search: "", rawTable: null });
    return () => useDoc.getState().unload();
  }, [docId, session]);

  // Default to the first page; fall back when the active page disappears.
  useEffect(() => {
    if (activePage === "raw") return;
    if (!activePage || !pages.some((p) => p.id === activePage)) {
      setActivePage(pages[0]?.id ?? (doc ? "raw" : null));
    }
  }, [pages, activePage, setActivePage, doc]);

  useEffect(() => {
    if (doc) document.title = `${doc.name} · LM Data Universe`;
  }, [doc]);

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

  if (!session || (loading && !doc)) {
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
        {role === "viewer" && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">View only</span>}
        <div className="flex items-center">
          <IconButton title="Undo (Ctrl+Z)" disabled={!undoCount} onClick={() => useDoc.getState().undo()}>
            <Undo2 size={16} />
          </IconButton>
          <IconButton title="Redo (Ctrl+Y)" disabled={!redoCount} onClick={() => useDoc.getState().redo()}>
            <Redo2 size={16} />
          </IconButton>
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            id="doc-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search in selected widget"
            className="h-8 w-60 rounded-md border border-gray-200 bg-gray-50 pl-8 pr-2 text-sm outline-none focus:border-brand-400 focus:bg-white"
          />
        </div>
        {canEdit && currentPage && (
          <Button size="sm" onClick={() => setDialog("widget")}>
            <Plus size={14} /> Add widget
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={(e) => setExportMenu(e.currentTarget)}>
          <Download size={14} /> Export
        </Button>
        <Button size="sm" variant="primary" onClick={() => setSharing(true)}>
          <Share2 size={14} /> Share
        </Button>
        <IconButton title="Toggle settings panel" onClick={() => openPanel(panel ? null : pageWidgets[0] ? { tab: "widget", widgetId: pageWidgets[0].id } : null)}>
          <LayoutPanelLeft size={16} className="rotate-180" />
        </IconButton>
      </header>

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
          </div>
        </nav>

        {/* content */}
        <main className="scroll-thin min-w-0 flex-1 overflow-auto bg-gray-50 p-4">
          {activePage === "raw" ? (
            <RawDataView />
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

        <RightPanel />
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

      {sharing && (
        <ShareDialog
          open
          onClose={() => setSharing(false)}
          kind="document"
          targetId={doc.id}
          title={doc.name}
          canManage={role === "owner"}
          currentUserId={session.user.id}
        />
      )}
    </div>
  );
}
