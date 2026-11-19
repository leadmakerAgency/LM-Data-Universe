"use client";

// "Files": every file in the document in one list, with the record and column
// holding it, what it belongs to (the records that record points at, e.g. its
// client or deal), its version, and whether its rows were imported.
import { FileSpreadsheet, Search, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Input, Select } from "@/components/ui";
import { KIND_LABEL, attachmentMeta, fileKind, formatBytes, useAttachments, type FileKind } from "@/lib/attachments";
import { fileLocations, referencedRecords } from "@/lib/fileIndex";
import { supabase } from "@/lib/supabase";
import { tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";
import type { ImportRecord } from "./FileViewer";
import { FileCover, tileTitleText } from "./RecordTile";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");

export function FilesView() {
  const docId = useDoc((s) => s.docId);
  const tables = useDoc((s) => s.tables);
  const version = useDoc((s) => s.version);
  useAttachments((s) => s.version);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind | "all">("all");
  const [table, setTable] = useState("all");
  const [imports, setImports] = useState<ImportRecord[]>([]);

  useEffect(() => {
    if (!docId) return;
    void supabase()
      .from("doc_imports")
      .select("*")
      .eq("doc_id", docId)
      .order("id", { ascending: false })
      .limit(500)
      .then(({ data }) => setImports((data as ImportRecord[] | null) ?? []));
  }, [docId, version]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const files = useMemo(() => fileLocations().list, [version, docId]);
  const importedBy = useMemo(() => {
    const m = new Map<string, ImportRecord>();
    for (const i of imports) if (i.attachment_id && !m.has(i.attachment_id)) m.set(i.attachment_id, i);
    return m;
  }, [imports]);

  const rows = files
    .map((f) => {
      const m = attachmentMeta(docId, f.id);
      const col = tableColumns(f.tableRef).find((c) => c.id === f.colId);
      const record = tileTitleText(f.tableRef, f.rowId, {});
      // What the record belongs to: the records it references (its client, its deal…).
      const belongs = referencedRecords(f.tableRef, f.rowId)
        .slice(0, 3)
        .map((r) => `${r.col.label || r.col.col_id}: ${r.rowIds.slice(0, 2).map((id) => tileTitleText(r.tableRef, id, {})).join(", ")}`);
      return { f, m, col, record, belongs, kind: m ? fileKind(m) : ("other" as FileKind) };
    })
    .filter((r) => (kind === "all" || r.kind === kind) && (table === "all" || r.f.tableRef === table))
    .filter((r) => {
      const q = query.trim().toLowerCase();
      return !q || `${r.m?.file_name ?? ""} ${r.record} ${r.belongs.join(" ")}`.toLowerCase().includes(q);
    });
  const tablesWithFiles = [...new Set(files.map((f) => f.tableRef))];
  const totalBytes = rows.reduce((n, r) => n + (r.m?.size ?? 0), 0);
  const siblings = rows.map((r) => r.f.id);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Files</h1>
        <p className="mt-1 text-sm text-gray-600">Every file attached to a record in this document. Click one to preview it, see its versions, or import a spreadsheet into a table.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a file, record or client" className="w-72 pl-8" aria-label="Find a file" />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value as FileKind | "all")} className="!w-40" aria-label="Kind of file">
          <option value="all">All kinds</option>
          {(Object.keys(KIND_LABEL) as FileKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}s
            </option>
          ))}
        </Select>
        <Select value={table} onChange={(e) => setTable(e.target.value)} className="!w-44" aria-label="Table">
          <option value="all">All tables</option>
          {tablesWithFiles.map((t) => (
            <option key={t} value={t}>
              {tables.get(t)?.table_id}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-xs text-gray-500">
          {rows.length.toLocaleString()} file{rows.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-500">
          {files.length ? "No files match." : "No files yet. Add an Attachments column to a table and upload files to its cells; they all show up here."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="w-14 px-3 py-2" />
                <th className="px-2 py-2 font-medium">File</th>
                <th className="px-2 py-2 font-medium">On</th>
                <th className="px-2 py-2 font-medium">Belongs to</th>
                <th className="px-2 py-2 font-medium">Data</th>
                <th className="px-2 py-2 text-right font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.slice(0, 1000).map((r) => {
                const imp = importedBy.get(r.f.id);
                return (
                  <tr key={`${r.f.tableRef}:${r.f.rowId}:${r.f.colId}:${r.f.id}`} className="cursor-pointer hover:bg-brand-50/40" onClick={() => useUi.getState().openFile({ id: r.f.id, siblings })}>
                    <td className="px-3 py-1.5">
                      <div className="h-9 w-11 overflow-hidden rounded border border-gray-200">
                        {r.kind === "image" ? <FileCover id={r.f.id} height={36} /> : <div className="flex h-full items-center justify-center bg-gray-50 text-[9px] font-semibold text-gray-500">{r.kind === "table" ? <FileSpreadsheet size={16} className="text-emerald-600" /> : (r.m?.file_name.split(".").pop() ?? "").slice(0, 4).toUpperCase()}</div>}
                      </div>
                    </td>
                    <td className="max-w-72 px-2 py-1.5">
                      <div className="truncate font-medium" title={r.m?.file_name}>{r.m?.file_name ?? "…"}</div>
                      <div className="text-xs text-gray-500">
                        {KIND_LABEL[r.kind]}
                        {r.m && (r.m.version ?? 1) > 1 ? ` · version ${r.m.version}` : ""}
                        {r.m?.table_info ? ` · ${r.m.table_info.rows.toLocaleString()} × ${r.m.table_info.cols}` : ""}
                      </div>
                    </td>
                    <td className="max-w-56 px-2 py-1.5">
                      <button
                        className="block max-w-full truncate text-left text-brand-700 hover:underline"
                        title="Open the record"
                        onClick={(e) => {
                          e.stopPropagation();
                          useUi.getState().openRecordCard({ tableRef: r.f.tableRef, rowId: r.f.rowId });
                        }}
                      >
                        {r.record}
                      </button>
                      <div className="truncate text-xs text-gray-500">
                        {tables.get(r.f.tableRef)?.table_id} · {r.col?.label || r.col?.col_id}
                      </div>
                    </td>
                    <td className="max-w-56 px-2 py-1.5 text-xs text-gray-600">
                      {r.belongs.map((b) => (
                        <div key={b} className="truncate" title={b}>{b}</div>
                      ))}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-600">
                      {imp ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800" title={`${imp.rows_added} added, ${imp.rows_updated} updated on ${when(imp.created_at)}`}>
                          <Table2 size={11} /> {imp.table_ref ? (tables.get(imp.table_ref)?.table_id ?? "removed table") : "imported"}
                        </span>
                      ) : r.kind === "table" ? (
                        <span className="text-gray-400">not imported</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-gray-600">{r.m ? formatBytes(r.m.size) : ""}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-gray-600">{when(r.m?.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 1000 && <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">Showing the first 1,000. Narrow the list with the search or the filters.</p>}
        </div>
      )}
    </div>
  );
}
