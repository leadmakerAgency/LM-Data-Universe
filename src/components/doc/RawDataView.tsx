"use client";

import clsx from "clsx";
import { Database, Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Button, IconButton, MenuItem, Popover, useDialogs } from "@/components/ui";
import { GridWidget } from "./GridWidget";
import { ImportDialog } from "./ImportDialog";
import { exportTable } from "@/lib/exporter";
import type { DocWidget, WidgetOptions } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

/** Every table in the document with its full data, independent of pages. */
export function RawDataView() {
  const tables = useDoc((s) => s.tables);
  const rows = useDoc((s) => s.rows);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  useDoc((s) => s.version);
  const rawTable = useUi((s) => s.rawTable);
  const setRawTable = useUi((s) => s.setRawTable);
  const { confirm, prompt } = useDialogs();
  const [options, setOptions] = useState<Record<string, WidgetOptions>>({});
  const [importing, setImporting] = useState(false);
  const [exportMenu, setExportMenu] = useState<{ el: HTMLElement; table: string } | null>(null);
  const exportBlocked = useDoc((s) => s.role !== "owner" && !!s.acl?.settings.block_copies);

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
              {!exportBlocked && (
                <IconButton
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  title="Download this table"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExportMenu({ el: e.currentTarget, table: t.id });
                  }}
                >
                  <Download size={13} />
                </IconButton>
              )}
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
            <Button onClick={() => setImporting(true)}>
              <Upload size={14} /> Import data…
            </Button>
          </div>
        )}
      </div>
      {importing && <ImportDialog initialTable={null} onClose={() => setImporting(false)} />}
      <Popover anchor={exportMenu?.el ?? null} onClose={() => setExportMenu(null)} align="end">
        {(["csv", "tsv", "xlsx"] as const).map((f) => (
          <MenuItem key={f} icon={<Download size={14} />} onClick={() => (exportMenu && exportTable(exportMenu.table, f), setExportMenu(null))}>
            {f === "csv" ? "CSV (.csv)" : f === "tsv" ? "Tab-separated (.tsv)" : "Excel (.xlsx)"}
          </MenuItem>
        ))}
      </Popover>
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
