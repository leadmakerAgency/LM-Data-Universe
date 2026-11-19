"use client";

// Gallery: records as tiles with a cover (the first file of an Attachments
// column), or one tile per file. Click a cover to open the file viewer, drop
// files on a tile to attach them, group tiles into sections by a column.
import clsx from "clsx";
import { Maximize2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { attachmentIds, attachmentMeta, formatBytes, uploadAttachment, useAttachments } from "@/lib/attachments";
import { displayValue } from "@/lib/format";
import type { CellValue, DocColumn, DocWidget } from "@/lib/types";
import { FormulaError } from "@engine/values";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";
import { useWidgetRows } from "./CardWidgets";
import { FileCover, RecordTile, tileTitleText } from "./RecordTile";

const SIZES = { small: { min: 150, cover: 100 }, medium: { min: 220, cover: 150 }, large: { min: 300, cover: 210 } };

export function GalleryWidget({ widget }: { widget: DocWidget }) {
  const { ids, link } = useWidgetRows(widget);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const docId = useDoc((s) => s.docId);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  useAttachments((s) => s.version);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const o = widget.options;
  const tableRef = widget.table_ref ?? "";
  const cols = tableColumns(tableRef);
  const fileCols = cols.filter((c) => c.type === "Attachments" && !c.is_formula);
  const coverCol = fileCols.find((c) => c.id === o.tileCover);
  const groupCol = cols.find((c) => c.id === o.galGroup);
  const size = SIZES[o.galSize ?? "medium"];
  const [dropOn, setDropOn] = useState<number | null>(null);
  const rows = useDoc.getState().rows.get(tableRef);
  const engine = getDerived().engine;

  useEffect(() => {
    if (link.recordId !== null && ids.includes(link.recordId)) useDoc.getState().setCursor(widget.id, link.recordId);
  }, [link.recordId, ids, widget.id]);

  // Sections, in the order their first record appears.
  const sections: { label: string; ids: number[] }[] = [];
  if (!groupCol) sections.push({ label: "", ids });
  else {
    const ctx = displayCtx();
    const map = new Map<string, number[]>();
    for (const id of ids) {
      const v = engine.safeValue(groupCol, id);
      const label = (v instanceof FormulaError ? "" : displayValue(ctx, groupCol, v)) || "(blank)";
      const list = map.get(label);
      if (list) list.push(id);
      else map.set(label, [id]);
    }
    for (const [label, list] of map) sections.push({ label, ids: list });
  }

  if (link.waiting) return <div className="flex h-full items-center justify-center text-sm text-gray-400">Select a record in the linked widget.</div>;

  const attach = async (rowId: number, files: FileList, col: DocColumn | undefined) => {
    if (!col || !docId || !canEdit) return toast.info(col ? "You can't add files here." : "Choose a cover column in the widget options to drop files on tiles.");
    const added: string[] = [];
    for (const f of [...files]) {
      try {
        added.push((await uploadAttachment(docId, f)).id);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }
    if (!added.length) return;
    const current = attachmentIds(useDoc.getState().rows.get(tableRef)?.get(rowId)?.data[col.id]);
    await useDoc.getState().setCells([{ tableRef, rowId, colId: col.id, value: [...current, ...added] }]);
  };

  const addRecord = async () => {
    const made = await useDoc.getState().addRows(tableRef, [{ data: link.newRowDefaults as Record<string, CellValue> }]);
    if (made[0]) {
      useDoc.getState().setCursor(widget.id, made[0].id);
      useUi.getState().openRecordCard({ tableRef, rowId: made[0].id });
    }
  };

  const grid = { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${size.min}px, 1fr))`, gap: 12 } as const;
  const fileMode = o.galMode === "files";
  // In file mode: every file of the cover column (or of all file columns), with the cell it sits in.
  const filesOf = (rowId: number) =>
    (coverCol ? [coverCol] : fileCols).flatMap((c) => attachmentIds(rows?.get(rowId)?.data[c.id]).map((id) => ({ id, colId: c.id, rowId })));
  const allFiles = fileMode ? ids.flatMap(filesOf) : [];

  const recordTile = (id: number) => {
    const coverIds = coverCol ? attachmentIds(rows?.get(id)?.data[coverCol.id]) : [];
    return (
      <div
        key={id}
        tabIndex={0}
        onClick={() => useDoc.getState().setCursor(widget.id, id)}
        onDoubleClick={() => useUi.getState().openRecordCard({ tableRef, rowId: id })}
        onKeyDown={(e) => e.key === "Enter" && useUi.getState().openRecordCard({ tableRef, rowId: id })}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropOn(id);
        }}
        onDragLeave={() => setDropOn((d) => (d === id ? null : d))}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDropOn(null);
          void attach(id, e.dataTransfer.files, coverCol ?? fileCols[0]);
        }}
        className={clsx(
          "group/tile relative cursor-pointer overflow-hidden rounded-lg border bg-white shadow-sm outline-none hover:shadow focus-visible:ring-2 focus-visible:ring-brand-300",
          selected === id ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200",
          dropOn === id && "ring-2 ring-brand-400",
        )}
      >
        {coverCol && !coverIds.length && <div className="flex items-center justify-center bg-gray-50 text-xs text-gray-300" style={{ height: size.cover }}>{canEdit ? "Drop a file here" : "No file"}</div>}
        <RecordTile tableRef={tableRef} rowId={id} options={o} coverHeight={size.cover} exclude={[groupCol?.id]} />
        {coverIds.length > 0 && (
          <button
            className="absolute inset-x-0 top-0 cursor-zoom-in"
            style={{ height: size.cover }}
            title={coverIds.length > 1 ? `Open the ${coverIds.length} files` : "Open the file"}
            onClick={(e) => {
              e.stopPropagation();
              useDoc.getState().setCursor(widget.id, id);
              useUi.getState().openFile({ id: coverIds[0], siblings: coverIds });
            }}
          />
        )}
        {coverIds.length > 1 && <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{coverIds.length}</span>}
        <button
          className="absolute bottom-1.5 right-1.5 hidden rounded bg-white/90 p-1 text-gray-500 shadow-sm hover:text-brand-700 group-focus-within/tile:block group-hover/tile:block"
          title="Open the record"
          onClick={(e) => {
            e.stopPropagation();
            useUi.getState().openRecordCard({ tableRef, rowId: id });
          }}
        >
          <Maximize2 size={13} />
        </button>
      </div>
    );
  };

  const fileTile = (f: { id: string; rowId: number }) => {
    const m = attachmentMeta(docId, f.id);
    return (
      <button
        key={`${f.rowId}:${f.id}`}
        onClick={() => {
          useDoc.getState().setCursor(widget.id, f.rowId);
          useUi.getState().openFile({ id: f.id, siblings: allFiles.map((x) => x.id) });
        }}
        className={clsx("overflow-hidden rounded-lg border bg-white text-left shadow-sm hover:shadow", selected === f.rowId ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200")}
      >
        <FileCover id={f.id} height={size.cover} fit={o.tileCoverFit} />
        <div className="px-2.5 py-1.5">
          <div className="truncate text-xs font-medium" title={m?.file_name}>{m?.file_name ?? "…"}</div>
          <div className="truncate text-[11px] text-gray-500">
            {tileTitleText(tableRef, f.rowId, o)}
            {m ? ` · ${formatBytes(m.size)}` : ""}
            {m && (m.version ?? 1) > 1 ? ` · v${m.version}` : ""}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="scroll-thin h-full overflow-auto bg-gray-50/50 p-3 text-sm">
      {sections.map((s) => {
        const sectionFiles = fileMode ? s.ids.flatMap(filesOf) : [];
        return (
          <section key={s.label} className="mb-4 last:mb-0">
            {groupCol && (
              <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {s.label} <span className="font-normal normal-case text-gray-400">{fileMode ? `${sectionFiles.length} files` : s.ids.length}</span>
              </h4>
            )}
            <div style={grid}>{fileMode ? sectionFiles.map(fileTile) : s.ids.map(recordTile)}</div>
          </section>
        );
      })}
      {(fileMode ? allFiles.length === 0 : ids.length === 0) && <p className="px-1 py-6 text-center text-sm text-gray-400">{fileMode ? "No files yet." : "No records."}</p>}
      {canEdit && !fileMode && (
        <button className="mt-3 inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:border-brand-400 hover:text-brand-700" onClick={() => void addRecord()}>
          <Plus size={13} /> Add a record
        </button>
      )}
    </div>
  );
}
