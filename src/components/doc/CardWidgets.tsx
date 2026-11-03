"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, IconButton, useDialogs } from "@/components/ui";
import { CellContent } from "./CellContent";
import { FieldInput } from "./FieldInput";
import type { CellValue, DocWidget } from "@/lib/types";
import { visibleColumns, widgetRows } from "@/lib/view";
import { getDerived, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

export function useWidgetRows(widget: DocWidget) {
  const version = useDoc((s) => s.version);
  const sourceCursor = useDoc((s) => (widget.link_source ? s.cursors[widget.link_source] : undefined));
  const search = useUi((s) => (s.activeWidget === widget.id ? s.search : ""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => widgetRows(widget, { search }), [version, widget, search, sourceCursor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cols = useMemo(() => visibleColumns(widget), [version, widget]);
  return { ...result, cols };
}

/** One record at a time, with editable fields and record navigation. */
export function CardWidget({ widget }: { widget: DocWidget }) {
  const { ids, link, cols } = useWidgetRows(widget);
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  const { confirm } = useDialogs();
  const [own, setOwn] = useState<number | null>(null);

  const recordId =
    link.recordId !== null && ids.includes(link.recordId)
      ? link.recordId
      : own !== null && ids.includes(own)
        ? own
        : (ids[0] ?? null);
  const index = recordId === null ? -1 : ids.indexOf(recordId);

  useEffect(() => {
    useDoc.getState().setCursor(widget.id, recordId);
  }, [recordId, widget.id]);

  const go = (delta: number) => {
    const next = ids[index + delta];
    if (next !== undefined) setOwn(next);
  };

  const addRecord = async () => {
    if (!widget.table_ref) return;
    const rows = await useDoc.getState().addRows(widget.table_ref, [{ data: link.newRowDefaults as Record<string, CellValue> }]);
    if (rows[0]) setOwn(rows[0].id);
  };

  const removeRecord = async () => {
    if (recordId === null || !widget.table_ref) return;
    if (!(await confirm({ title: "Delete this record?", message: "You can undo this with Ctrl+Z.", confirmLabel: "Delete", danger: true }))) return;
    await useDoc.getState().deleteRows(widget.table_ref, [recordId]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-gray-100 px-3 py-1.5 text-xs text-gray-500">
        <IconButton onClick={() => go(-1)} disabled={index <= 0} title="Previous record">
          <ChevronLeft size={15} />
        </IconButton>
        <span>{ids.length ? `${index + 1} of ${ids.length}` : "No records"}</span>
        <IconButton onClick={() => go(1)} disabled={index < 0 || index >= ids.length - 1} title="Next record">
          <ChevronRight size={15} />
        </IconButton>
        <div className="flex-1" />
        {canEdit && !link.waiting && (
          <>
            <Button size="sm" variant="ghost" onClick={addRecord}>
              <Plus size={13} /> New
            </Button>
            {recordId !== null && (
              <IconButton onClick={removeRecord} title="Delete record">
                <Trash2 size={14} />
              </IconButton>
            )}
          </>
        )}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {recordId === null ? (
          <div className="py-8 text-center text-sm text-gray-400">
            {link.waiting ? "Select a record in the linked widget." : "No record to show."}
          </div>
        ) : (
          <div className="grid gap-x-4 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {cols.map((c) => (
              <FieldInput key={c.id} col={c} rowId={recordId} canEdit={canEdit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Scrollable list of record cards; selecting one drives linked widgets. */
export function CardListWidget({ widget }: { widget: DocWidget }) {
  const { ids, link, cols } = useWidgetRows(widget);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  const shown = cols.slice(0, 6);

  useEffect(() => {
    if (link.recordId !== null && ids.includes(link.recordId)) useDoc.getState().setCursor(widget.id, link.recordId);
    else if (selected === null || !ids.includes(selected)) useDoc.getState().setCursor(widget.id, ids[0] ?? null);
  }, [ids, link.recordId, selected, widget.id]);

  if (!ids.length) {
    return <div className="py-8 text-center text-sm text-gray-400">{link.waiting ? "Select a record in the linked widget." : "No records."}</div>;
  }
  const [title, ...rest] = shown;
  return (
    <div className="scroll-thin h-full overflow-y-auto p-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {ids.map((id) => (
          <button
            key={id}
            onClick={() => useDoc.getState().setCursor(widget.id, id)}
            className={clsx(
              "rounded-lg border bg-white p-3 text-left shadow-sm transition",
              selected === id ? "border-brand-500 ring-2 ring-brand-100" : "border-gray-200 hover:border-gray-300",
            )}
          >
            {title && (
              <div className="mb-2 truncate text-sm font-semibold">
                <CellContent col={title} value={getDerived().engine.safeValue(title, id)} />
              </div>
            )}
            <dl className="space-y-1">
              {rest.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  <dt className="w-24 shrink-0 truncate text-gray-500">{c.label || c.col_id}</dt>
                  <dd className="flex min-w-0 flex-1">
                    <CellContent col={c} value={getDerived().engine.safeValue(c, id)} />
                  </dd>
                </div>
              ))}
            </dl>
          </button>
        ))}
      </div>
    </div>
  );
}
