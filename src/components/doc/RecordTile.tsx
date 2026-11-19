"use client";

// One record as a tile: optional cover, title, a few fields (only those with a
// value) and a file counter. Boards, galleries and the timeline's hover card
// all draw records with it, so a record looks the same everywhere.
import clsx from "clsx";
import { FileSpreadsheet, FileText, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { attachmentIds, attachmentMeta, attachmentMissing, attachmentThumbUrl, fileKind, formatBytes, useAttachments, type AttachmentMeta } from "@/lib/attachments";
import { choiceColor, displayValue } from "@/lib/format";
import { mergeStyle, ruleMatches, styleToCss } from "@/lib/styles";
import type { CellStyle, DocColumn, WidgetOptions } from "@/lib/types";
import { FormulaError, isEmptyValue } from "@engine/values";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { CellContent } from "./CellContent";

/** The column a tile is titled by: the chosen one, else the first text column, else the first column. */
export function tileTitleColumn(tableRef: string | null, o: WidgetOptions): DocColumn | undefined {
  const cols = tableColumns(tableRef);
  return cols.find((c) => c.id === o.tileTitle) ?? cols.find((c) => c.type === "Text") ?? cols[0];
}

export function tileTitleText(tableRef: string, rowId: number, o: WidgetOptions): string {
  const col = tileTitleColumn(tableRef, o);
  if (!col) return `#${rowId}`;
  const v = getDerived().engine.safeValue(col, rowId);
  return (v instanceof FormulaError ? "" : displayValue(displayCtx(), col, v)) || `#${rowId}`;
}

/** The fields under the title: the chosen ones, or the first three that aren't already shown some other way. */
export function tileFieldColumns(tableRef: string | null, o: WidgetOptions, exclude: (string | null | undefined)[] = []): DocColumn[] {
  const cols = tableColumns(tableRef);
  const title = tileTitleColumn(tableRef, o)?.id;
  if (o.tileFields) return o.tileFields.map((id) => cols.find((c) => c.id === id)).filter((c): c is DocColumn => !!c && c.id !== title);
  const skip = new Set([title, o.tileCover, ...exclude]);
  return cols.filter((c) => !skip.has(c.id) && c.type !== "Attachments").slice(0, 3);
}

function useThumb(m: AttachmentMeta | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!m) return;
    let live = true;
    void attachmentThumbUrl(m).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [m]);
  return url;
}

/** A file as a picture: its thumbnail, or a typed placeholder (a spreadsheet says how big it is). */
export function FileCover({ id, height, fit = "crop", className }: { id: string; height: number; fit?: "crop" | "fit"; className?: string }) {
  const docId = useDoc((s) => s.docId);
  useAttachments((s) => s.version);
  const m = attachmentMeta(docId, id);
  const url = useThumb(m);
  const kind = m ? fileKind(m) : "other";
  return (
    <div className={clsx("flex w-full items-center justify-center overflow-hidden bg-gray-100", className)} style={{ height }} title={m ? `${m.file_name} (${formatBytes(m.size)})` : undefined}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={m?.file_name ?? ""} draggable={false} loading="lazy" className={clsx("h-full w-full", fit === "fit" ? "object-contain" : "object-cover")} />
      ) : !m ? (
        <span className="text-xs text-gray-400">{attachmentMissing(id) ? "File not found" : ""}</span>
      ) : (
        <div className="flex max-w-full flex-col items-center gap-1 px-2 text-center text-gray-500">
          {kind === "table" ? <FileSpreadsheet size={Math.min(36, height / 3)} className="text-emerald-600" /> : <FileText size={Math.min(36, height / 3)} />}
          <span className="max-w-full truncate text-[11px] font-medium text-gray-700">{m.file_name}</span>
          <span className="text-[10px]">
            {m.table_info ? `${m.table_info.rows.toLocaleString()} × ${m.table_info.cols}` : formatBytes(m.size)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Ids of every file a record holds, across its Attachments columns. */
export function recordFileIds(tableRef: string, rowId: number): string[] {
  const row = useDoc.getState().rows.get(tableRef)?.get(rowId);
  if (!row) return [];
  return tableColumns(tableRef)
    .filter((c) => c.type === "Attachments" && !c.is_formula)
    .flatMap((c) => attachmentIds(row.data[c.id]));
}

export function RecordTile({
  tableRef,
  rowId,
  options,
  exclude,
  coverHeight = 120,
  footer,
}: {
  tableRef: string;
  rowId: number;
  options: WidgetOptions;
  /** Columns already shown by the view itself (the stack column of a board). */
  exclude?: (string | null | undefined)[];
  coverHeight?: number;
  footer?: React.ReactNode;
}) {
  useDoc((s) => s.version);
  const { engine } = getDerived();
  const cols = tableColumns(tableRef);
  const row = useDoc.getState().rows.get(tableRef)?.get(rowId);
  const title = tileTitleText(tableRef, rowId, options);
  const fields = tileFieldColumns(tableRef, options, exclude);
  const coverCol = cols.find((c) => c.id === options.tileCover && c.type === "Attachments");
  const coverId = coverCol ? attachmentIds(row?.data[coverCol.id])[0] : undefined;
  const colorCol = cols.find((c) => c.id === options.tileColor && c.type === "Choice");
  const colorValue = colorCol ? engine.safeValue(colorCol, rowId) : null;
  const stripe = colorCol && typeof colorValue === "string" && colorValue ? choiceColor(colorCol, colorValue) : undefined;
  let style: CellStyle = {};
  for (const r of options.rowRules ?? []) if (ruleMatches(r, tableRef, rowId)) style = mergeStyle(style, r.style);
  const files = recordFileIds(tableRef, rowId).length;

  return (
    <div className="overflow-hidden rounded-md" style={{ ...styleToCss(style), boxShadow: stripe ? `inset 3px 0 0 ${stripe}` : undefined }}>
      {coverId && <FileCover id={coverId} height={coverHeight} fit={options.tileCoverFit} />}
      <div className="space-y-1 px-2.5 py-2">
        <div className="break-words text-sm font-medium leading-snug">{title}</div>
        {fields.map((c) => {
          const v = engine.safeValue(c, rowId);
          if (isEmptyValue(v) || v === false) return null;
          return (
            <div key={c.id} className="min-w-0 text-xs text-gray-600">
              {options.tileLabels && <div className="text-[10px] uppercase tracking-wide text-gray-400">{c.label || c.col_id}</div>}
              <div className="flex min-w-0 items-center">
                <CellContent col={c} value={v} raw={row?.data[c.id]} />
              </div>
            </div>
          );
        })}
        {(files > 0 || footer) && (
          <div className="flex items-center gap-2 pt-0.5 text-[11px] text-gray-500">
            {files > 0 && (
              <span className="inline-flex items-center gap-0.5" title={`${files} file${files === 1 ? "" : "s"}`}>
                <Paperclip size={11} /> {files}
              </span>
            )}
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
