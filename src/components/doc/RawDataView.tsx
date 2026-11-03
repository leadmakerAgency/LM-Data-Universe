"use client";

import clsx from "clsx";
import { Database, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button, IconButton, Spinner, useDialogs } from "@/components/ui";
import { GridWidget } from "./GridWidget";
import { addTablesToDoc, parseImportFile } from "@/lib/docBuilder";
import { errorMessage } from "@/lib/supabase";
import type { DocWidget, WidgetOptions } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";

/** Every table in the document with its full data, independent of pages. */
export function RawDataView() {
  const tables = useDoc((s) => s.tables);
  const rows = useDoc((s) => s.rows);
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  useDoc((s) => s.version);
  const rawTable = useUi((s) => s.rawTable);
  const setRawTable = useUi((s) => s.setRawTable);
  const { confirm, prompt } = useDialogs();
  const [options, setOptions] = useState<Record<string, WidgetOptions>>({});
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = [...tables.values()].sort((a, b) => a.position - b.position);
  const selected = list.find((t) => t.id === rawTable) ?? list[0];

  const widget: DocWidget | null = selected
    ? {
            id: `raw-${selected.id}`,
            doc_id: selected.doc_id,
            page_id: "",
            table_ref: selected.id,
            type: "table",
            title: selected.table_id,
            position: 0,
            width: 12,
            height: 600,
            options: options[selected.id] ?? {},
            link_source: null,
            link_col: null,
          }
    : null;

  const importInto = async (file: File) => {
    setBusy(true);
    try {
      const specs = await parseImportFile(file);
      const docId = useDoc.getState().docId!;
      await addTablesToDoc(docId, specs, undefined, {
        existingTableIds: list.map((t) => t.table_id),
        startPosition: Math.max(0, ...list.map((t) => t.position)),
      });
      await useDoc.getState().load(docId);
      toast.success(`Imported ${specs.length} table${specs.length > 1 ? "s" : ""}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex w-64 shrink-0 flex-col gap-2">
        {list.map((t) => (
          <div
            key={t.id}
            onClick={() => setRawTable(t.id)}
            className={clsx(
              "group cursor-pointer rounded-lg border bg-white p-3 shadow-sm",
              selected?.id === t.id ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200 hover:border-gray-300",
            )}
          >
            <div className="flex items-center gap-2">
              <Database size={15} className="text-brand-600" />
              <span className="flex-1 truncate font-medium">{t.table_id}</span>
              {canEdit && (
                <>
                  <IconButton
                    className="h-6 w-6 opacity-0 group-hover:opacity-100"
                    title="Rename table"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const name = await prompt({ title: "Rename table", label: "Table name (used in formulas)", initial: t.table_id });
                      if (name) await useDoc.getState().renameTable(t.id, name);
                    }}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    className="h-6 w-6 opacity-0 group-hover:opacity-100"
                    title="Delete table"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const ok = await confirm({
                        title: `Delete table ${t.table_id}?`,
                        message: "The table, all of its rows, and every widget showing it will be deleted. This cannot be undone.",
                        confirmLabel: "Delete table",
                        danger: true,
                      });
                      if (ok) await useDoc.getState().deleteTable(t.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </>
              )}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {rows.get(t.id)?.size ?? 0} rows · {tableColumns(t.id).length} columns
            </div>
          </div>
        ))}
        {canEdit && (
          <div className="mt-1 flex flex-col gap-2">
            <Button onClick={async () => {
              const t = await useDoc.getState().addTable();
              if (t) setRawTable(t.id);
            }}>
              <Plus size={14} /> Add empty table
            </Button>
            <Button onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : <Upload size={14} />} Import CSV / Excel
            </Button>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept=".csv,.tsv,.txt,.xlsx,.xlsm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importInto(f);
              }}
            />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        {widget ? (
          <GridWidget
            key={widget.id}
            widget={widget}
            setOptions={(o) => setOptions((prev) => ({ ...prev, [widget.table_ref!]: { ...(prev[widget.table_ref!] ?? {}), ...o } }))}
          />
        ) : (
          <div className="p-8 text-center text-sm text-gray-500">This document has no tables yet.</div>
        )}
      </div>
    </div>
  );
}
