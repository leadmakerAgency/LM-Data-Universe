"use client";

// The record page: one record of any table, opened from a row, a card, a
// reference or a link in an email. Beside its fields it gathers what belongs
// to it: the records that point at it (a client's deals, a deal's tasks), its
// files and theirs, its comments and its history.
import clsx from "clsx";
import { ChevronLeft, ChevronRight, ExternalLink, FileUp, MessageSquare, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, IconButton, Spinner } from "@/components/ui";
import { attachmentIds, attachmentMeta, formatBytes, uploadAttachment, useAttachments } from "@/lib/attachments";
import { cardFields, tableCardLayout } from "@/lib/cardLayout";
import { fileLocations, referencedRecords, relatedRecords } from "@/lib/fileIndex";
import { supabase } from "@/lib/supabase";
import type { CellValue, DocColumn } from "@/lib/types";
import { personName, useComments } from "@/store/comments";
import { getDerived, tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";
import { FieldInput } from "./FieldInput";
import { FileCover, tileTitleText } from "./RecordTile";

type Tab = "details" | "related" | "files" | "comments" | "activity";
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

interface LoggedAction {
  id: number;
  author: string | null;
  created_at: string;
  kind: string;
  source: string;
  actions: { op: string; table?: string; ids?: number[]; records?: { id?: number; values?: Record<string, unknown>; data?: Record<string, unknown> }[] }[];
}

function FileRow({ id, siblings, sub }: { id: string; siblings: string[]; sub?: string }) {
  const docId = useDoc((s) => s.docId);
  const m = attachmentMeta(docId, id);
  return (
    <button className="flex w-full items-center gap-2.5 rounded-md border border-gray-200 bg-white p-1.5 text-left hover:border-brand-300 hover:bg-brand-50/40" onClick={() => useUi.getState().openFile({ id, siblings })}>
      <div className="h-10 w-12 shrink-0 overflow-hidden rounded border border-gray-100">
        <FileCover id={id} height={40} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={m?.file_name}>{m?.file_name ?? "…"}</div>
        <div className="truncate text-xs text-gray-500">
          {m ? formatBytes(m.size) : ""}
          {m && (m.version ?? 1) > 1 ? ` · version ${m.version}` : ""}
          {m?.table_info ? ` · ${m.table_info.rows.toLocaleString()} × ${m.table_info.cols}` : ""}
          {sub ? ` · ${sub}` : ""}
        </div>
      </div>
    </button>
  );
}

export function Activity({ tableRef, rowId }: { tableRef: string; rowId: number }) {
  const docId = useDoc((s) => s.docId);
  const [items, setItems] = useState<{ a: LoggedAction; text: string }[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!docId) return;
    let live = true;
    void (async () => {
      const { data } = await supabase().from("doc_actions").select("id,author,created_at,kind,source,actions").eq("doc_id", docId).order("id", { ascending: false }).limit(400);
      if (!live) return;
      const cols = new Map(tableColumns(tableRef).map((c) => [c.id, c.label || c.col_id]));
      const out: { a: LoggedAction; text: string }[] = [];
      for (const a of (data as LoggedAction[] | null) ?? []) {
        for (const op of a.actions ?? []) {
          if (op.table !== tableRef) continue;
          if (op.op === "AddRecords" && op.records?.some((r) => r.id === rowId)) out.push({ a, text: a.kind === "undo" ? "Brought back (undo)" : "Created" });
          else if (op.op === "RemoveRecords" && op.ids?.includes(rowId)) out.push({ a, text: "Deleted" });
          else if (op.op === "UpdateRecords") {
            const rec = op.records?.find((r) => r.id === rowId);
            const changed = Object.keys(rec?.values ?? {}).map((k) => cols.get(k)).filter(Boolean);
            if (rec) out.push({ a, text: changed.length ? `Changed ${changed.slice(0, 6).join(", ")}${changed.length > 6 ? "…" : ""}` : "Moved" });
          }
        }
      }
      setItems(out.slice(0, 100));
      const authors = [...new Set(out.map((x) => x.a.author).filter((x): x is string => !!x))];
      if (authors.length) {
        const { data: people } = await supabase().from("profiles").select("id,full_name,email").in("id", authors);
        if (live) setNames(new Map(((people as { id: string; full_name: string | null; email: string }[] | null) ?? []).map((p) => [p.id, p.full_name || p.email])));
      }
    })();
    return () => {
      live = false;
    };
  }, [docId, tableRef, rowId]);
  if (!items) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!items.length) return <p className="py-6 text-center text-sm text-gray-500">No changes to this record in the recent history you can see.</p>;
  return (
    <ul className="divide-y divide-gray-100 text-sm">
      {items.map(({ a, text }, i) => (
        <li key={`${a.id}:${i}`} className="flex items-baseline gap-3 py-1.5">
          <span className="w-36 shrink-0 text-xs text-gray-500">{when(a.created_at)}</span>
          <span className="min-w-0 flex-1">{text}</span>
          <span className="shrink-0 text-xs text-gray-500">
            {a.author ? (names.get(a.author) ?? "someone") : a.source === "form" ? "a form" : a.source}
            {a.source === "api" ? " (API)" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Popup showing one record of any table, opened from a row or a reference. */
export function RecordCardModal() {
  const card = useUi((s) => s.recordCard);
  const version = useDoc((s) => s.version);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const docId = useDoc((s) => s.docId);
  const comments = useComments((s) => s.comments);
  const people = useComments((s) => s.people);
  useAttachments((s) => s.version);
  const [tab, setTab] = useState<Tab>("details");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tableRef = card?.tableRef ?? "";
  const rowId = card?.rowId ?? 0;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const related = useMemo(() => (card ? relatedRecords(tableRef, rowId) : []), [card, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const points = useMemo(() => (card ? referencedRecords(tableRef, rowId) : []), [card, version]);
  // Files: the record's own, then those of the records that point at it.
   
  const files = useMemo(() => {
    if (!card) return { own: [] as { col: DocColumn; ids: string[] }[], theirs: [] as { label: string; items: { id: string; sub: string }[] }[], all: [] as string[] };
    const row = useDoc.getState().rows.get(tableRef)?.get(rowId);
    const own = tableColumns(tableRef)
      .filter((c) => c.type === "Attachments" && !c.is_formula)
      .map((c) => ({ col: c, ids: attachmentIds(row?.data[c.id]) }));
    const { list } = fileLocations();
    const theirs = related
      .map((g) => {
        const set = new Set(g.rowIds);
        const items = list.filter((f) => f.tableRef === g.tableRef && set.has(f.rowId)).map((f) => ({ id: f.id, sub: tileTitleText(f.tableRef, f.rowId, {}) }));
        return { label: useDoc.getState().tables.get(g.tableRef)?.table_id ?? "", items };
      })
      .filter((g) => g.items.length);
    return { own, theirs, all: [...own.flatMap((o) => o.ids), ...theirs.flatMap((t) => t.items.map((i) => i.id))] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, version, related]);
  const threads = useMemo(() => [...comments.values()].filter((c) => c.table_ref === tableRef && c.row_id === rowId).sort((a, b) => a.created_at.localeCompare(b.created_at)), [comments, tableRef, rowId]);

  if (!card) return null;
  const table = useDoc.getState().tables.get(tableRef);
  const exists = useDoc.getState().rows.get(tableRef)?.has(rowId);
  const ids = getDerived().engine.rowIds(tableRef);
  const i = ids.indexOf(rowId);
  const open = (t: string, r: number) => useUi.getState().openRecordCard({ tableRef: t, rowId: r });
  const close = () => useUi.getState().openRecordCard(null);
  const go = (d: number) => {
    const next = ids[i + d];
    if (next !== undefined) open(tableRef, next);
  };
  const { layout, hidden } = tableCardLayout(tableRef);
  const fields = cardFields(tableRef, layout, hidden);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const relatedCount = related.reduce((n, g) => n + g.rowIds.length, 0);
  const fileCount = files.all.length;
  const roots = threads.filter((c) => !c.parent_id);

  const upload = async (col: DocColumn, list: FileList | File[]) => {
    if (!docId) return;
    setBusy(true);
    const added: string[] = [];
    for (const f of [...list]) {
      try {
        added.push((await uploadAttachment(docId, f)).id);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }
    if (added.length) {
      const current = attachmentIds(useDoc.getState().rows.get(tableRef)?.get(rowId)?.data[col.id]);
      await useDoc.getState().setCells([{ tableRef, rowId, colId: col.id, value: [...current, ...added] }]);
    }
    setBusy(false);
  };

  const addRelated = async (t: string, col: DocColumn) => {
    const value: CellValue = col.type === "RefList" ? [rowId] : rowId;
    const made = await useDoc.getState().addRows(t, [{ data: { [col.id]: value } }]);
    if (made[0]) open(t, made[0].id);
  };

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "details", label: "Details", show: true },
    { id: "related", label: `Related${relatedCount ? ` ${relatedCount}` : ""}`, show: related.length > 0 || points.length > 0 },
    { id: "files", label: `Files${fileCount ? ` ${fileCount}` : ""}`, show: files.own.length > 0 || files.theirs.length > 0 },
    { id: "comments", label: `Comments${roots.length ? ` ${roots.length}` : ""}`, show: roots.length > 0 },
    { id: "activity", label: "Activity", show: role === "owner" || role === "editor" },
  ];
  const shown = tabs.filter((t) => t.show);
  const current = shown.some((t) => t.id === tab) ? tab : "details";

  return (
    <Modal
      open
      onClose={close}
      width={820}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{exists ? tileTitleText(tableRef, rowId, {}) : "Record"}</span>
          <span className="shrink-0 text-sm font-normal text-gray-400">
            {table?.table_id} #{rowId}
          </span>
          <span className="ml-2 flex shrink-0 items-center text-xs font-normal text-gray-500">
            <IconButton onClick={() => go(-1)} disabled={i <= 0} title="Previous record">
              <ChevronLeft size={15} />
            </IconButton>
            {i >= 0 ? `${i + 1} of ${ids.length}` : ""}
            <IconButton onClick={() => go(1)} disabled={i < 0 || i >= ids.length - 1} title="Next record">
              <ChevronRight size={15} />
            </IconButton>
          </span>
        </span>
      }
    >
      {!exists ? (
        <p className="py-6 text-center text-sm text-gray-500">This record no longer exists.</p>
      ) : (
        <>
          {shown.length > 1 && (
            <div className="-mt-1 mb-4 flex gap-1 border-b border-gray-100" role="tablist">
              {shown.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={current === t.id}
                  onClick={() => setTab(t.id)}
                  className={clsx("-mb-px border-b-2 px-3 py-1.5 text-sm", current === t.id ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900")}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {current === "details" && (
            <div className={clsx("grid gap-x-4 gap-y-3", layout?.theme === "compact" && "gap-y-1.5")} style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              {fields.map((f) => (
                <div key={f.col.id} style={{ gridColumn: `span ${f.span} / span ${f.span}` }} className={clsx(layout?.theme === "bordered" && "rounded-md border border-gray-200 p-2")}>
                  <FieldInput col={f.col} rowId={rowId} canEdit={canEdit} />
                </div>
              ))}
            </div>
          )}

          {current === "related" && (
            <div className="space-y-5">
              {points.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Belongs to</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {points.flatMap((p) =>
                      p.rowIds.map((id) => (
                        <button key={`${p.col.id}:${id}`} className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-xs hover:border-brand-300 hover:bg-brand-50" onClick={() => open(p.tableRef, id)}>
                          <span className="text-gray-500">{p.col.label || p.col.col_id}:</span> {tileTitleText(p.tableRef, id, {})} <ExternalLink size={11} className="text-gray-400" />
                        </button>
                      )),
                    )}
                  </div>
                </div>
              )}
              {related.map((g) => {
                const name = useDoc.getState().tables.get(g.tableRef)?.table_id ?? "";
                const cols = tableColumns(g.tableRef).filter((c) => c.id !== g.col.id && c.type !== "Attachments").slice(1, 4);
                return (
                  <div key={g.col.id}>
                    <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {name} <span className="font-normal normal-case text-gray-400">by {g.col.label || g.col.col_id} · {g.rowIds.length}</span>
                      {canEdit && (
                        <button className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case text-brand-700 hover:bg-brand-50" onClick={() => void addRelated(g.tableRef, g.col)}>
                          <Plus size={11} /> Add
                        </button>
                      )}
                    </h3>
                    {g.rowIds.length === 0 ? (
                      <p className="text-xs text-gray-400">None yet.</p>
                    ) : (
                      <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                        {g.rowIds.slice(0, 50).map((id) => (
                          <li key={id}>
                            <button className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-brand-50/40" onClick={() => open(g.tableRef, id)}>
                              <span className="min-w-0 flex-1 truncate font-medium">{tileTitleText(g.tableRef, id, {})}</span>
                              {cols.map((c) => {
                                const v = getDerived().engine.safeValue(c, id);
                                const text = tileTitleText(g.tableRef, id, { tileTitle: c.id });
                                return v === null || v === "" || text.startsWith("#") ? null : (
                                  <span key={c.id} className="max-w-32 shrink-0 truncate text-xs text-gray-500" title={c.label || c.col_id}>
                                    {text}
                                  </span>
                                );
                              })}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {g.rowIds.length > 50 && <p className="mt-1 text-xs text-gray-500">And {g.rowIds.length - 50} more.</p>}
                  </div>
                );
              })}
            </div>
          )}

          {current === "files" && (
            <div className="space-y-5">
              {files.own.map(({ col, ids: own }) => (
                <div
                  key={col.id}
                  onDragOver={(e) => canEdit && e.dataTransfer.types.includes("Files") && e.preventDefault()}
                  onDrop={(e) => {
                    if (!canEdit || !e.dataTransfer.files.length) return;
                    e.preventDefault();
                    void upload(col, e.dataTransfer.files);
                  }}
                >
                  <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {col.label || col.col_id} <span className="font-normal text-gray-400">{own.length}</span>
                    {canEdit && (
                      <button
                        className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case text-brand-700 hover:bg-brand-50"
                        disabled={busy}
                        onClick={() => {
                          input.current?.setAttribute("data-col", col.id);
                          input.current?.click();
                        }}
                      >
                        <FileUp size={11} /> {busy ? "Uploading…" : "Upload"}
                      </button>
                    )}
                  </h3>
                  {own.length ? (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {own.map((id) => (
                        <FileRow key={id} id={id} siblings={files.all} />
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">{canEdit ? "Drop files here or use Upload." : "No files."}</p>
                  )}
                </div>
              ))}
              {files.theirs.map((g) => (
                <div key={g.label}>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    From its {g.label} <span className="font-normal text-gray-400">{g.items.length}</span>
                  </h3>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {g.items.slice(0, 100).map((f) => (
                      <FileRow key={f.id} id={f.id} siblings={files.all} sub={f.sub} />
                    ))}
                  </div>
                </div>
              ))}
              <input
                ref={input}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const col = files.own.find((o) => o.col.id === e.target.getAttribute("data-col"))?.col;
                  const list = e.target.files ? [...e.target.files] : [];
                  e.target.value = "";
                  if (col && list.length) void upload(col, list);
                }}
              />
            </div>
          )}

          {current === "comments" && (
            <ul className="space-y-2">
              {roots.map((c) => {
                const col = c.col_id ? useDoc.getState().columns.get(c.col_id) : undefined;
                const replies = threads.filter((r) => r.parent_id === c.id).length;
                return (
                  <li key={c.id}>
                    <button
                      className="w-full rounded-md border border-gray-200 px-3 py-2 text-left hover:border-brand-300"
                      onClick={() => c.col_id && useComments.getState().open({ tableRef, rowId, colId: c.col_id, anchor: null })}
                    >
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <MessageSquare size={12} /> <span className="font-medium text-gray-700">{personName(people.get(c.author))}</span> on {col?.label || col?.col_id || "a removed column"} · {when(c.created_at)}
                        {c.resolved && <span className="rounded-full bg-gray-100 px-1.5">resolved</span>}
                        {replies > 0 && <span>· {replies} repl{replies === 1 ? "y" : "ies"}</span>}
                      </div>
                      <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm">{c.body}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {current === "activity" && <Activity key={`${tableRef}:${rowId}`} tableRef={tableRef} rowId={rowId} />}
        </>
      )}
    </Modal>
  );
}
