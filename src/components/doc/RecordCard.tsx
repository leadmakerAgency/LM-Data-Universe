"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Modal, IconButton } from "@/components/ui";
import { cardFields, tableCardLayout } from "@/lib/cardLayout";
import { getDerived, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";
import { FieldInput } from "./FieldInput";

/** Popup showing one record of any table, opened from a row or a reference. */
export function RecordCardModal() {
  const card = useUi((s) => s.recordCard);
  useDoc((s) => s.version);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  if (!card) return null;
  const { tableRef, rowId } = card;
  const table = useDoc.getState().tables.get(tableRef);
  const exists = useDoc.getState().rows.get(tableRef)?.has(rowId);
  const ids = getDerived().engine.rowIds(tableRef);
  const i = ids.indexOf(rowId);
  const close = () => useUi.getState().openRecordCard(null);
  const go = (d: number) => {
    const next = ids[i + d];
    if (next !== undefined) useUi.getState().openRecordCard({ tableRef, rowId: next });
  };
  const { layout, hidden } = tableCardLayout(tableRef);
  const fields = cardFields(tableRef, layout, hidden);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  return (
    <Modal
      open
      onClose={close}
      width={760}
      title={
        <span className="flex items-center gap-2">
          {table?.table_id ?? "Record"} <span className="text-sm font-normal text-gray-400">#{rowId}</span>
          <span className="ml-2 flex items-center text-xs font-normal text-gray-500">
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
      {exists ? (
        <div className={clsx("grid gap-x-4 gap-y-3", layout?.theme === "compact" && "gap-y-1.5")} style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {fields.map((f) => (
            <div key={f.col.id} style={{ gridColumn: `span ${f.span} / span ${f.span}` }} className={clsx(layout?.theme === "bordered" && "rounded-md border border-gray-200 p-2")}>
              <FieldInput col={f.col} rowId={rowId} canEdit={canEdit} />
            </div>
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-gray-500">This record no longer exists.</p>
      )}
    </Modal>
  );
}
