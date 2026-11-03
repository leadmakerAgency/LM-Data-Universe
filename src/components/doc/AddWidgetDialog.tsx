"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { Button, Input, Label, Modal, Select } from "@/components/ui";
import { WIDGET_ICONS, widgetTitle } from "./WidgetFrame";
import { WIDGET_TYPES, type DocWidget, type WidgetType } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

export interface LinkOption {
  key: string;
  sourceId: string;
  linkCol: string | null;
  label: string;
}

/** Ways a widget on `tableRef` can follow the selection of the given widgets. */
export function linkOptions(tableRef: string | null, candidates: DocWidget[]): LinkOption[] {
  if (!tableRef) return [];
  const out: LinkOption[] = [];
  const cols = tableColumns(tableRef);
  for (const s of candidates) {
    if (!s.table_ref || !["table", "card", "card_list", "summary"].includes(s.type)) continue;
    const name = widgetTitle(s);
    if (s.table_ref === tableRef) {
      out.push({
        key: `${s.id}|`,
        sourceId: s.id,
        linkCol: null,
        label: s.type === "summary" ? `${name} (records in selected group)` : `${name} (same record)`,
      });
    }
    if (s.type === "summary") continue;
    for (const c of cols) {
      if ((c.type === "Ref" || c.type === "RefList") && c.options.refTable === s.table_ref && !c.is_formula) {
        out.push({ key: `${s.id}|${c.id}`, sourceId: s.id, linkCol: c.id, label: `${name} → by ${c.label || c.col_id}` });
      }
    }
  }
  return out;
}

export function AddWidgetDialog({ mode, onClose }: { mode: "page" | "widget"; onClose: () => void }) {
  const tables = useDoc((s) => s.tables);
  const widgets = useDoc((s) => s.widgets);
  const activePage = useUi((s) => s.activePage);
  const setActivePage = useUi((s) => s.setActivePage);
  const sortedTables = [...tables.values()].sort((a, b) => a.position - b.position);
  const [type, setType] = useState<WidgetType>("table");
  const [tableRef, setTableRef] = useState<string>(sortedTables[0]?.id ?? "new");
  const [linkKey, setLinkKey] = useState("");
  const [pageName, setPageName] = useState("");
  const [busy, setBusy] = useState(false);

  const pageWidgets = useMemo(
    () => (mode === "widget" ? [...widgets.values()].filter((w) => w.page_id === activePage).sort((a, b) => a.position - b.position) : []),
    [mode, widgets, activePage],
  );
  const links = tableRef === "new" ? [] : linkOptions(tableRef, pageWidgets);

  const create = async () => {
    setBusy(true);
    const link = links.find((l) => l.key === linkKey);
    const spec = { type, tableRef, linkSource: link?.sourceId ?? null, linkCol: link?.linkCol ?? null };
    if (mode === "page") {
      const fallback = tableRef === "new" ? "New page" : (tables.get(tableRef)?.table_id ?? "New page");
      const page = await useDoc.getState().addPage(pageName.trim() || fallback, { ...spec, width: 12 });
      if (page) setActivePage(page.id);
    } else if (activePage) {
      await useDoc.getState().addWidget(activePage, spec);
    }
    setBusy(false);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "page" ? "Add a new page" : "Add a widget to this page"}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={busy}>
            {busy ? "Adding…" : mode === "page" ? "Add page" : "Add widget"}
          </Button>
        </>
      }
    >
      <Label>Widget</Label>
      <div className="grid grid-cols-3 gap-2">
        {WIDGET_TYPES.map((t) => {
          const Icon = WIDGET_ICONS[t.type];
          return (
            <button
              key={t.type}
              onClick={() => setType(t.type)}
              className={clsx(
                "rounded-lg border p-3 text-left transition",
                type === t.type ? "border-brand-500 bg-brand-50 ring-2 ring-brand-100" : "border-gray-200 hover:border-gray-300",
              )}
            >
              <Icon size={18} className={type === t.type ? "text-brand-600" : "text-gray-400"} />
              <div className="mt-1.5 text-sm font-medium">{t.label}</div>
              <div className="text-xs text-gray-500">{t.description}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <Label>Data</Label>
          <Select value={tableRef} onChange={(e) => (setTableRef(e.target.value), setLinkKey(""))}>
            {sortedTables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.table_id}
              </option>
            ))}
            <option value="new">+ New empty table</option>
          </Select>
        </div>
        {mode === "page" ? (
          <div>
            <Label>Page name</Label>
            <Input value={pageName} onChange={(e) => setPageName(e.target.value)} placeholder="Optional" />
          </div>
        ) : (
          <div>
            <Label>Select by</Label>
            <Select value={linkKey} onChange={(e) => setLinkKey(e.target.value)} disabled={!links.length}>
              <option value="">{links.length ? "Not linked" : "No compatible widgets"}</option>
              {links.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {mode === "widget" && (
        <p className="mt-3 text-xs text-gray-500">
          Linking makes the new widget follow the row selected in another widget, e.g. show a customer&apos;s orders. Links use Reference columns.
        </p>
      )}
    </Modal>
  );
}
