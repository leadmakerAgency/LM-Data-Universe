"use client";

import { Button, Modal } from "@/components/ui";
import { convertValue, displayValue, isInvalid } from "@/lib/format";
import { COLUMN_TYPES, type CellValue, type ColumnOptions, type ColumnType, type DocColumn } from "@/lib/types";
import { displayCtx, getDerived, useDoc } from "@/store/docStore";

/** What a data column's values become under a new type, before the change is made. */
export function previewTypeChange(col: DocColumn, type: ColumnType, options: ColumnOptions) {
  const next: DocColumn = { ...col, type, options: { ...col.options, ...options } };
  const ctx = displayCtx();
  const { engine } = getDerived();
  const rows = [...(useDoc.getState().rows.get(col.table_ref)?.values() ?? [])].filter((r) => r.data[col.id] !== null && r.data[col.id] !== undefined && r.data[col.id] !== "");
  let changed = 0;
  let failed = 0;
  const samples: { before: string; after: string; bad: boolean }[] = [];
  for (const r of rows) {
    const raw = r.data[col.id] as CellValue;
    const after = convertValue(raw, col, next, ctx, engine.safeValue(col, r.id));
    const bad = isInvalid(next, after) || (after === null && raw !== null);
    if (JSON.stringify(after) !== JSON.stringify(raw)) changed++;
    if (bad) failed++;
    if (samples.length < 12 && (bad || samples.filter((s) => !s.bad).length < 8)) {
      samples.push({
        before: displayValue(ctx, col, engine.safeValue(col, r.id)),
        after: bad ? String(Array.isArray(after) ? after.join(", ") : (after ?? "(empty)")) : displayValue(ctx, next, after),
        bad,
      });
    }
  }
  return { total: rows.length, changed, failed, samples, next };
}

export function TypeChangePreview({
  col,
  type,
  options,
  onApply,
  onClose,
}: {
  col: DocColumn;
  type: ColumnType;
  options: ColumnOptions;
  onApply: () => void;
  onClose: () => void;
}) {
  const p = previewTypeChange(col, type, options);
  const label = (t: ColumnType) => COLUMN_TYPES.find((x) => x.type === t)?.label ?? t;
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={`Change ${col.label || col.col_id} to ${label(type)}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onApply}>
            Change type
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-gray-600">
        {p.total} value{p.total === 1 ? "" : "s"}: {p.changed} will be converted
        {p.failed ? (
          <>
            , <span className="font-medium text-red-600">{p.failed} can&apos;t be read as {label(type)}</span> and will show in red (or be cleared)
          </>
        ) : null}
        . You can undo this.
      </p>
      {p.samples.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="pb-1 text-left font-medium">Now ({label(col.type)})</th>
              <th className="pb-1 text-left font-medium">After ({label(type)})</th>
            </tr>
          </thead>
          <tbody>
            {p.samples.map((s, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="max-w-0 truncate py-1 pr-3">{s.before}</td>
                <td className={`max-w-0 truncate py-1 ${s.bad ? "text-red-600" : ""}`}>{s.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
