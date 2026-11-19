"use client";

// The file viewer: any attached file, full size. Images and PDFs are shown,
// CSV / Excel files as a grid with a line of facts per column, text as text.
// Beside it: what the file is, its versions, where its rows were imported, and
// the actions (download, new version, import into a table, update the data).
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Download, FileUp, History, RefreshCw, Table2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Modal, Spinner } from "@/components/ui";
import {
  KIND_LABEL,
  attachmentBytes,
  attachmentHistory,
  attachmentIds,
  attachmentMeta,
  attachmentMissing,
  attachmentUrl,
  fileKind,
  formatBytes,
  uploadAttachment,
  useAttachments,
  type AttachmentMeta,
} from "@/lib/attachments";
import { guessColumnType, readSheets, type ImportMode, type Sheet } from "@/lib/importer";
import { errorMessage, supabase } from "@/lib/supabase";
import { COLUMN_TYPES } from "@/lib/types";
import { fileCell } from "@/lib/fileIndex";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";

export interface ImportRecord {
  id: number;
  attachment_id: string | null;
  file_name: string;
  file_version: number | null;
  sheet: string | null;
  table_ref: string | null;
  mode: "new" | "add" | "update";
  mapping: { header: string; col: string }[];
  key_cols: string[];
  rows_added: number;
  rows_updated: number;
  created_at: string;
}

const PREVIEW_ROWS = 500;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function useUrl(m: AttachmentMeta | undefined, on: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!m || !on) return;
    let live = true;
    void attachmentUrl(m).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [m, on]);
  return m && on ? url : null;
}

/** Reads a spreadsheet file's sheets (cached per file for this visit). */
const sheetCache = new Map<string, Promise<Sheet[]>>();
export function fileSheets(m: AttachmentMeta): Promise<Sheet[]> {
  let p = sheetCache.get(m.id);
  if (!p) {
    p = attachmentBytes(m).then((bytes) => readSheets(m.file_name, m.mime, bytes));
    p.catch(() => sheetCache.delete(m.id));
    sheetCache.set(m.id, p);
  }
  return p;
}

function TablePreview({ m }: { m: AttachmentMeta }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ix, setIx] = useState(0);
  useEffect(() => {
    let live = true;
    fileSheets(m).then(
      (s) => live && setSheets(s),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [m]);
  const sheet = sheets?.[ix];
  // Per column: the type it looks like, how many cells are empty, how many different values.
  const facts = useMemo(() => {
    if (!sheet) return [];
    return sheet.header.map((_, i) => {
      let empty = 0;
      const distinct = new Set<string>();
      for (const r of sheet.rows) {
        const v = (r[i] ?? "").trim();
        if (!v) empty++;
        else if (distinct.size < 5000) distinct.add(v);
      }
      const type = guessColumnType(sheet, i);
      return { type: COLUMN_TYPES.find((t) => t.type === type)?.label ?? type, empty, distinct: distinct.size };
    });
  }, [sheet]);
  if (error) return <p className="p-6 text-sm text-red-600">{error}</p>;
  if (!sheets) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!sheet) return <p className="p-6 text-sm text-gray-500">This file has no rows.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-xs text-gray-600">
        {sheets.length > 1 &&
          sheets.map((s, i) => (
            <button key={s.name + i} className={clsx("rounded px-2 py-0.5", i === ix ? "bg-brand-50 font-medium text-brand-700" : "hover:bg-gray-100")} onClick={() => setIx(i)}>
              {s.name}
            </button>
          ))}
        <span className="ml-auto">
          {sheet.rows.length.toLocaleString()} rows × {sheet.header.length} columns
          {sheet.rows.length > PREVIEW_ROWS ? ` · showing the first ${PREVIEW_ROWS}` : ""}
        </span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-left text-xs">
          <thead className="sticky top-0 z-[1] bg-gray-50">
            <tr>
              <th className="border-b border-r border-gray-200 px-2 py-1 font-normal text-gray-400">#</th>
              {sheet.header.map((h, i) => (
                <th key={i} className="min-w-28 max-w-64 border-b border-r border-gray-200 px-2 py-1 align-top">
                  <div className="truncate font-semibold text-gray-800" title={h}>{h}</div>
                  <div className="whitespace-nowrap font-normal text-gray-500">
                    {facts[i]?.type} · {facts[i]?.distinct.toLocaleString()} different{facts[i]?.empty ? ` · ${facts[i].empty.toLocaleString()} empty` : ""}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(0, PREVIEW_ROWS).map((r, ri) => (
              <tr key={ri} className="odd:bg-white even:bg-gray-50/50">
                <td className="border-b border-r border-gray-100 px-2 py-0.5 text-gray-400">{ri + 1}</td>
                {sheet.header.map((_, ci) => (
                  <td key={ci} className="max-w-64 truncate border-b border-r border-gray-100 px-2 py-0.5" title={r[ci]}>
                    {r[ci]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextPreview({ m }: { m: AttachmentMeta }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    attachmentBytes(m).then(
      (b) => live && setText(new TextDecoder().decode(b.slice(0, 200_000)) + (b.byteLength > 200_000 ? "\n\n… (the rest is not shown)" : "")),
      () => live && setText("This file couldn't be opened."),
    );
    return () => {
      live = false;
    };
  }, [m]);
  if (text === null) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <pre className="scroll-thin h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-gray-800">{text}</pre>;
}

function Preview({ m }: { m: AttachmentMeta }) {
  const kind = fileKind(m);
  const url = useUrl(m, kind === "image" || kind === "pdf");
  if (kind === "table") return <TablePreview m={m} />;
  if (kind === "text") return <TextPreview m={m} />;
  if (kind === "image") {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt={m.file_name} className="max-h-full max-w-full object-contain" /> : <Spinner />}
      </div>
    );
  }
  if (kind === "pdf") return url ? <iframe src={url} title={m.file_name} className="h-full w-full" /> : <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div className="flex h-full items-center justify-center p-6 text-sm text-gray-500">No preview for this kind of file. Download it to open it.</div>;
}

async function download(m: AttachmentMeta) {
  const url = await attachmentUrl(m, true);
  if (!url) return toast.error("The file couldn't be downloaded.");
  const a = document.createElement("a");
  a.href = url;
  a.download = m.file_name;
  a.click();
}

export function FileViewerModal() {
  const view = useUi((s) => s.fileView);
  const docId = useDoc((s) => s.docId);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const tables = useDoc((s) => s.tables);
  useAttachments((s) => s.version);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  useDoc((s) => s.version);
  const m = view ? attachmentMeta(docId, view.id) : undefined;
  // The cell holding the file (a new version replaces it there).
  const cell = view ? (view.cell ?? fileCell(view.id)) : undefined;
  const [history, setHistory] = useState<AttachmentMeta[]>([]);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!m) return;
    let live = true;
    void (async () => {
      const older = await attachmentHistory(m);
      if (!live) return;
      setHistory(older);
      const { data } = await supabase()
        .from("doc_imports")
        .select("*")
        .in("attachment_id", [m.id, ...older.map((x) => x.id)])
        .order("id", { ascending: false })
        .limit(20);
      if (live) setImports((data as ImportRecord[] | null) ?? []);
    })();
    return () => {
      live = false;
    };
  }, [m]);

  if (!view) return null;
  const close = () => useUi.getState().openFile(null);
  const siblings = view.siblings ?? [view.id];
  const at = siblings.indexOf(view.id);
  const go = (d: number) => {
    const next = siblings[at + d];
    if (next) useUi.getState().openFile({ id: next, siblings });
  };
  const kind = m ? fileKind(m) : "other";
  const mine = imports.filter((i) => i.attachment_id === m?.id);
  // The newest import of an earlier version: what "Update the data" repeats.
  const earlier = imports.find((i) => i.attachment_id !== m?.id && i.table_ref && tables.has(i.table_ref));

  const importInto = async (preset?: ImportRecord) => {
    if (!m) return;
    setBusy(true);
    try {
      const sheets = await fileSheets(m);
      useUi.getState().importFrom({
        sheets,
        label: m.file_name,
        attachment: m,
        preset: preset?.table_ref
          ? { tableRef: preset.table_ref, mapping: preset.mapping ?? [], keys: preset.key_cols ?? [], mode: (preset.key_cols?.length ? "upsert" : "add") as ImportMode }
          : undefined,
      });
      close();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  };

  const newVersion = async (file: File) => {
    if (!m || !docId || !cell) return;
    setBusy(true);
    try {
      const next = await uploadAttachment(docId, file, { previous: m, note });
      const { tableRef, rowId, colId } = cell;
      const current = attachmentIds(useDoc.getState().rows.get(tableRef)?.get(rowId)?.data[colId]);
      await useDoc.getState().setCells([{ tableRef, rowId, colId, value: current.map((id) => (id === m.id ? next.id : id)) }]);
      setNote("");
      useUi.getState().openFile({ id: next.id, siblings: siblings.map((id) => (id === m.id ? next.id : id)) });
      toast.success(`Version ${next.version} uploaded`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <Modal
      open
      onClose={close}
      width={1080}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{m?.file_name ?? "File"}</span>
          {siblings.length > 1 && (
            <span className="ml-2 flex shrink-0 items-center text-xs font-normal text-gray-500">
              <IconButton onClick={() => go(-1)} disabled={at <= 0} title="Previous file">
                <ChevronLeft size={15} />
              </IconButton>
              {at + 1} of {siblings.length}
              <IconButton onClick={() => go(1)} disabled={at >= siblings.length - 1} title="Next file">
                <ChevronRight size={15} />
              </IconButton>
            </span>
          )}
        </span>
      }
    >
      {!m ? (
        <p className="py-10 text-center text-sm text-gray-500">{attachmentMissing(view.id) ? "This file no longer exists, or you can't see it." : "Loading…"}</p>
      ) : (
        <div className="flex h-[70vh] min-h-0 gap-4">
          <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-gray-200">
            <Preview key={m.id} m={m} />
          </div>
          <aside className="scroll-thin flex w-64 shrink-0 flex-col gap-4 overflow-y-auto text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-gray-500">Kind</dt>
              <dd>{KIND_LABEL[kind]}</dd>
              <dt className="text-gray-500">Size</dt>
              <dd>
                {formatBytes(m.size)}
                {m.table_info ? ` · ${m.table_info.rows.toLocaleString()} × ${m.table_info.cols}` : ""}
              </dd>
              <dt className="text-gray-500">Version</dt>
              <dd>{m.version ?? 1}</dd>
              <dt className="text-gray-500">Added</dt>
              <dd>{when(m.created_at)}</dd>
              {m.note && (
                <>
                  <dt className="text-gray-500">Note</dt>
                  <dd className="break-words">{m.note}</dd>
                </>
              )}
            </dl>

            <div className="flex flex-col gap-1.5">
              <Button size="sm" onClick={() => void download(m)}>
                <Download size={13} /> Download
              </Button>
              {canEdit && kind === "table" && (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void importInto()}>
                  <Table2 size={13} /> Import into a table…
                </Button>
              )}
              {canEdit && kind === "table" && earlier && mine.length === 0 && (
                <Button size="sm" disabled={busy} onClick={() => void importInto(earlier)} title="Repeats the mapping used for the earlier version and shows what would change">
                  <RefreshCw size={13} /> Update “{tables.get(earlier.table_ref!)?.table_id}” from this version…
                </Button>
              )}
            </div>

            {canEdit && cell && (
              <div className="rounded-md border border-gray-200 p-2">
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-700">
                  <Upload size={12} /> New version
                </div>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="What changed (optional)"
                  className="mb-1.5 h-7 w-full rounded border border-gray-300 px-2 text-xs outline-none focus:border-brand-500"
                />
                <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
                  <FileUp size={13} /> {busy ? "Uploading…" : "Choose a file"}
                </Button>
                <input
                  ref={input}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void newVersion(f);
                  }}
                />
                <p className="mt-1 text-[11px] text-gray-500">The current file is kept as version {m.version ?? 1}.</p>
              </div>
            )}

            {history.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-700">
                  <History size={12} /> Earlier versions
                </div>
                <ul className="space-y-1">
                  {history.map((h) => (
                    <li key={h.id} className="rounded border border-gray-100 px-2 py-1 text-xs">
                      <div className="flex items-center gap-1">
                        <span className="font-medium">v{h.version ?? 1}</span>
                        <span className="truncate text-gray-500">{when(h.created_at)}</span>
                        <div className="flex-1" />
                        <button className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-brand-700" title={`Download ${h.file_name}`} onClick={() => void download(h)}>
                          <Download size={12} />
                        </button>
                      </div>
                      {h.note && <div className="break-words text-gray-600">{h.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {imports.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-700">
                  <Table2 size={12} /> Imported
                </div>
                <ul className="space-y-1">
                  {imports.map((i) => (
                    <li key={i.id} className="rounded border border-gray-100 px-2 py-1 text-xs text-gray-600">
                      <span className="font-medium text-gray-800">{i.table_ref ? (tables.get(i.table_ref)?.table_id ?? "a removed table") : "a table"}</span>
                      {i.file_version ? ` from v${i.file_version}` : ""}: {i.rows_added.toLocaleString()} added{i.rows_updated ? `, ${i.rows_updated.toLocaleString()} updated` : ""}
                      <div className="text-gray-400">{when(i.created_at)}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      )}
    </Modal>
  );
}
