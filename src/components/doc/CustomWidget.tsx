"use client";

// Custom widgets: a web page in a sandboxed frame, given this widget's data
// over postMessage (see public/widgets/lmdu-widget.js for the page side).
//
// The frame never shares this app's origin (no allow-same-origin), so it
// can't reach the session, cookies or the database. What it gets depends on
// the access level an editor grants:
//   none  its saved settings only
//   read  the records this widget shows (as the viewer sees them), with mapped
//         reference columns expanded to the linked records
//   full  also other tables, and adding, changing and removing records of
//         this widget's table, with the viewer's own permissions
import clsx from "clsx";
import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Button, Input, Select } from "@/components/ui";
import { useWidgetRows } from "./CardWidgets";
import { displayValue } from "@/lib/format";
import { FormulaError, RecordRef, RecordSet, isDate } from "@engine/values";
import type { CellValue, CustomAccess, DocColumn, DocWidget, WidgetOptions } from "@/lib/types";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";

export const BUILTIN_WIDGETS: { id: string; name: string; description: string }[] = [
  { id: "markdown", name: "Markdown / HTML viewer", description: "Shows a text column of the selected record as formatted text or HTML." },
  { id: "map", name: "Map", description: "Pins records with a latitude and longitude on a map." },
  { id: "invoice", name: "Invoice", description: "A printable invoice for the selected record and its line items." },
  { id: "labels", name: "Print labels", description: "A sheet of labels, one or more per record, ready to print." },
  { id: "chart", name: "Combo chart", description: "Bars and lines on two axes in one chart." },
];

const ACCESS_RANK: Record<CustomAccess, number> = { none: 0, read: 1, full: 2 };
const MAX_RECORDS = 5000;

/** What a widget page asked for in its "ready" message. */
export interface DeclaredColumn {
  name: string;
  title?: string;
  description?: string;
  optional?: boolean;
  multiple?: boolean;
  /** Column types it expects, e.g. "Numeric" or "Date,DateTime". */
  type?: string;
}
interface Declared {
  requires: CustomAccess;
  columns: DeclaredColumn[];
}
const useDeclared = create<{ byWidget: Record<string, Declared> }>(() => ({ byWidget: {} }));

/** The page to load, or null when the address isn't allowed. */
export function customSrc(o: WidgetOptions): string | null {
  if (o.builtin) return BUILTIN_WIDGETS.some((b) => b.id === o.builtin) ? `/widgets/${o.builtin}.html` : null;
  const url = (o.customUrl ?? "").trim();
  if (/^https:\/\/[^\s]+$/i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(url)) return url;
  return null;
}

// Built-in widgets are handed to their frame inline (srcdoc), with the widget
// API script already in place: a sandboxed frame has no origin of its own, and
// some browsers and blockers refuse its requests back to this site.
const builtinDocs = new Map<string, Promise<string>>();
function builtinDoc(id: string): Promise<string> {
  let p = builtinDocs.get(id);
  if (!p) {
    p = Promise.all([fetch(`/widgets/${id}.html`), fetch("/widgets/lmdu-widget.js")])
      .then(async ([page, api]) => {
        if (!page.ok || !api.ok) throw new Error("Could not load the widget");
        const [html, js] = await Promise.all([page.text(), api.text()]);
        return html.replace('<script src="lmdu-widget.js"></script>', () => `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>`);
      })
      .catch((e) => {
        builtinDocs.delete(id);
        throw e;
      });
    builtinDocs.set(id, p);
  }
  return p;
}

/** A value as plain JSON for the widget page. */
function jsonValue(col: DocColumn | null, v: unknown): unknown {
  if (v instanceof FormulaError) return { error: v.message };
  if (v instanceof RecordRef) return v.rowId;
  if (v instanceof RecordSet) return v.ids;
  if (isDate(v)) return col?.type === "Date" ? v.toISOString().slice(0, 10) : v.toISOString();
  if (Array.isArray(v)) return v.map((x) => jsonValue(null, x));
  if (v === undefined) return null;
  return v;
}

interface WidgetRecord {
  id: number;
  fields: Record<string, unknown>;
  display: Record<string, string>;
  [mapped: string]: unknown;
}

function recordOf(cols: DocColumn[], id: number): WidgetRecord {
  const { engine } = getDerived();
  const ctx = displayCtx();
  const fields: Record<string, unknown> = {};
  const display: Record<string, string> = {};
  for (const c of cols) {
    const v = engine.safeValue(c, id);
    fields[c.col_id] = jsonValue(c, v);
    display[c.col_id] = displayValue(ctx, c, v);
  }
  return { id, fields, display };
}

/** Records with mapped values added under the names the page declared. */
function buildRecords(tableRef: string, ids: number[], declared: Declared | undefined, mapping: WidgetOptions["customMapping"]): WidgetRecord[] {
  const cols = tableColumns(tableRef);
  const { engine } = getDerived();
  const out: WidgetRecord[] = [];
  for (const id of ids.slice(0, MAX_RECORDS)) {
    const rec = recordOf(cols, id);
    for (const d of declared?.columns ?? []) {
      const m = mapping?.[d.name];
      const list = (Array.isArray(m) ? m : m ? [m] : []).map((cid) => cols.find((c) => c.id === cid)).filter((c): c is DocColumn => !!c);
      const valueOf = (c: DocColumn) => {
        const v = engine.safeValue(c, id);
        // Mapped references come with the linked records.
        if ((c.type === "Ref" || c.type === "RefList") && c.options.refTable) {
          const tcols = tableColumns(c.options.refTable);
          const refIds = v instanceof RecordRef ? [v.rowId] : v instanceof RecordSet ? v.ids : [];
          const recs = refIds.filter((x) => x > 0).map((x) => recordOf(tcols, x));
          return c.type === "Ref" ? (recs[0] ?? null) : recs;
        }
        return jsonValue(c, v);
      };
      rec[d.name] = d.multiple ? list.map(valueOf) : list[0] ? valueOf(list[0]) : null;
    }
    out.push(rec);
  }
  return out;
}

type Inbound =
  | { type: "ready"; requires?: CustomAccess; columns?: (DeclaredColumn | string)[] }
  | { type: "setCursor"; id: number | null }
  | { type: "setOptions"; options: Record<string, unknown> }
  | { type: "apply"; reqId: number; actions: { op: "add" | "update" | "remove"; id?: number; fields?: Record<string, unknown> }[] }
  | { type: "fetchTable"; reqId: number; table: string };

export function CustomWidget({ widget, setOptions }: { widget: DocWidget; setOptions: (o: Partial<WidgetOptions>) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { ids, link } = useWidgetRows(widget);
  const version = useDoc((s) => s.version);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const own = useDoc((s) => s.cursors[widget.id] ?? null);
  // Linked to show the same record as another widget: that widget's selection.
  const cursor = link.recordId ?? own;
  const declared = useDeclared((s) => s.byWidget[widget.id]);
  // When the page said "ready" (and which page: a new address must say it again).
  const [ready, setReady] = useState<{ src: string | null; at: number }>({ src: null, at: 0 });
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const o = widget.options;
  const access: CustomAccess = o.customAccess ?? "none";
  const src = customSrc(o);
  const readyAt = ready.src === src ? ready.at : 0;
  // Built-ins: the page with the API inlined, once loaded.
  const [inline, setInline] = useState<{ id: string; html: string } | { id: string; error: string } | null>(null);
  const builtin = o.builtin && src ? o.builtin : null;
  useEffect(() => {
    if (!builtin) return;
    let live = true;
    builtinDoc(builtin).then(
      (html) => live && setInline({ id: builtin, html }),
      (e: Error) => live && setInline({ id: builtin, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [builtin]);
  const doc = builtin && inline?.id === builtin ? inline : null;
  const needs = declared?.requires ?? "none";
  const granted = ACCESS_RANK[access] >= ACCESS_RANK[needs];
  const mappingKey = JSON.stringify(o.customMapping ?? {});
  const optionsKey = JSON.stringify(o.customOptions ?? {});

  const records = useMemo(
    () => (readyAt && granted && access !== "none" && widget.table_ref ? buildRecords(widget.table_ref, ids, declared, o.customMapping) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readyAt, granted, access, widget.table_ref, ids, version, declared, mappingKey],
  );

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ lmdu: 1, ...msg }, "*");

  // Latest values for the message handler.
  const live = useRef({ widget, access, canEdit, ids, setOptions, src });
  useEffect(() => {
    live.current = { widget, access, canEdit, ids, setOptions, src };
  });

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as Inbound & { lmdu?: number };
      if (!m || m.lmdu !== 1 || typeof m.type !== "string") return;
      const { widget: w, access: acc, canEdit: editable, ids: shownIds } = live.current;
      const reply = (reqId: number, ok: boolean, result?: unknown, error?: string) => post({ type: "reply", reqId, ok, result, error });
      switch (m.type) {
        case "ready": {
          const requires: CustomAccess = m.requires === "full" || m.requires === "read" ? m.requires : "none";
          const columns = (Array.isArray(m.columns) ? m.columns : [])
            .slice(0, 50)
            .map((c) => (typeof c === "string" ? { name: c } : c))
            .filter((c): c is DeclaredColumn => !!c && typeof c.name === "string" && c.name.length > 0 && c.name.length < 100);
          useDeclared.setState((s) => ({ byWidget: { ...s.byWidget, [w.id]: { requires, columns } } }));
          setReady({ src: live.current.src, at: Date.now() });
          return;
        }
        case "setCursor":
          if (acc !== "none" && (m.id === null || shownIds.includes(Number(m.id)))) useDoc.getState().setCursor(w.id, m.id === null ? null : Number(m.id));
          return;
        case "setOptions":
          // Only editors' changes are saved; for others the page keeps them itself.
          if (editable && m.options && typeof m.options === "object" && JSON.stringify(m.options).length < 50_000) {
            live.current.setOptions({ customOptions: m.options });
          }
          return;
        case "fetchTable": {
          if (acc !== "full") return reply(m.reqId, false, undefined, "This widget needs full access to read other tables.");
          const t = [...useDoc.getState().tables.values()].find((x) => x.table_id === m.table || x.id === m.table);
          if (!t) return reply(m.reqId, false, undefined, `No table named ${m.table}`);
          return reply(m.reqId, true, buildRecords(t.id, getDerived().engine.rowIds(t.id), undefined, undefined));
        }
        case "apply": {
          if (acc !== "full" || !editable || !w.table_ref) return reply(m.reqId, false, undefined, "This widget may not change data here.");
          const cols = tableColumns(w.table_ref);
          const toData = (fields: Record<string, unknown> | undefined) => {
            const data: Record<string, CellValue> = {};
            for (const [k, v] of Object.entries(fields ?? {})) {
              const c = cols.find((x) => x.col_id === k || x.id === k);
              if (!c || c.is_formula) throw new Error(`Unknown or formula column ${k}`);
              data[c.id] = v as CellValue;
            }
            return data;
          };
          try {
            const actions = Array.isArray(m.actions) ? m.actions.slice(0, 500) : [];
            const added: number[] = [];
            for (const a of actions) {
              if (a.op === "add") {
                const rows = await useDoc.getState().addRows(w.table_ref, [{ data: toData(a.fields) }]);
                if (rows[0]) added.push(rows[0].id);
              } else if (a.op === "update" && typeof a.id === "number") {
                const data = toData(a.fields);
                await useDoc.getState().setCells(Object.entries(data).map(([colId, value]) => ({ tableRef: w.table_ref!, rowId: a.id!, colId, value })));
              } else if (a.op === "remove" && typeof a.id === "number") {
                await useDoc.getState().deleteRows(w.table_ref, [a.id]);
              }
            }
            return reply(m.reqId, true, { added });
          } catch (err) {
            return reply(m.reqId, false, undefined, err instanceof Error ? err.message : String(err));
          }
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Settings first, then data, then the selection.
  useEffect(() => {
    if (!readyAt) return;
    const t = widget.table_ref ? useDoc.getState().tables.get(widget.table_ref) : undefined;
    post({
      type: "init",
      access: granted ? access : "none",
      options: o.customOptions ?? {},
      canEdit,
      // Labels of the mapped columns, by the names the page declared.
      mapping:
        granted && access !== "none"
          ? Object.fromEntries(
              (declared?.columns ?? []).map((d) => {
                const m = o.customMapping?.[d.name];
                const labels = (Array.isArray(m) ? m : m ? [m] : []).map((id) => {
                  const c = useDoc.getState().columns.get(id);
                  return c ? c.label || c.col_id : "";
                });
                return [d.name, d.multiple ? labels : (labels[0] ?? null)];
              }),
            )
          : {},
      table: granted && access !== "none" && t ? { id: t.table_id, columns: tableColumns(t.id).map((c) => ({ id: c.col_id, label: c.label || c.col_id, type: c.type })) } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyAt, granted, access, optionsKey, canEdit, widget.table_ref, version, mappingKey, declared]);

  useEffect(() => {
    if (readyAt && granted && access !== "none") post({ type: "records", records });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  useEffect(() => {
    if (readyAt && granted && access !== "none") post({ type: "cursor", id: cursor });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, records]);

  if (!src) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
        {o.builtin || o.customUrl ? "This address can't be used: custom widgets need an https:// address." : "Pick a widget or enter its address in Widget options."}
      </div>
    );
  }
  return (
    <div className="relative flex h-full flex-col">
      {!granted && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          <ShieldAlert size={14} />
          <span className="flex-1">
            This widget asks for {needs === "full" ? "full document" : "read table"} access{canEdit ? "." : ". Ask an editor to allow it."}
          </span>
          {canEdit && (
            <Button size="sm" onClick={() => setOptions({ customAccess: needs })}>
              Allow
            </Button>
          )}
        </div>
      )}
      {builtin && doc && "error" in doc ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-gray-500">{doc.error}</div>
      ) : builtin && !doc ? (
        <div className="flex-1" />
      ) : (
        <iframe
          key={src}
          ref={frame}
          {...(builtin && doc && "html" in doc ? { srcDoc: doc.html } : { src })}
          title={widget.title || "Custom widget"}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ settings

export function CustomWidgetSettings({ widget, setOpt, canEdit }: { widget: DocWidget; setOpt: (o: Partial<WidgetOptions>) => void; canEdit: boolean }) {
  const o = widget.options;
  const declared = useDeclared((s) => s.byWidget[widget.id]);
  const cols = tableColumns(widget.table_ref);
  const [url, setUrl] = useState(o.customUrl ?? "");
  const kind = o.builtin ?? "url";
  const access = o.customAccess ?? "none";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const setMap = (name: string, v: string | string[] | null) => setOpt({ customMapping: { ...(o.customMapping ?? {}), [name]: v } });
  const typeOk = (c: DocColumn, d: DeclaredColumn) => !d.type || d.type.split(",").some((t) => t.trim() === c.type || t.trim() === "Any");

  return (
    <>
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Custom widget</div>
        <div className="space-y-2">
          <Select
            value={kind}
            disabled={!canEdit}
            onChange={(e) => {
              const v = e.target.value;
              setOpt(v === "url" ? { builtin: null } : { builtin: v, customAccess: o.customAccess === "full" ? "read" : (o.customAccess ?? "read") });
            }}
          >
            {BUILTIN_WIDGETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="url">Your own (web address)…</option>
          </Select>
          <p className="text-xs text-gray-500">{BUILTIN_WIDGETS.find((b) => b.id === kind)?.description ?? "Any page that uses the widget API below."}</p>
          {kind === "url" && (
            <div>
              <Input
                value={url}
                disabled={!canEdit}
                placeholder="https://example.com/my-widget.html"
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => url.trim() !== (o.customUrl ?? "") && setOpt({ customUrl: url.trim() })}
              />
              {url && !customSrc({ customUrl: url }) && <p className="mt-1 text-xs text-red-600">Use an https:// address (http:// only for localhost).</p>}
              <p className="mt-1 text-xs text-gray-500">
                The page loads <code className="rounded bg-gray-100 px-1">{origin}/widgets/lmdu-widget.js</code> and calls{" "}
                <code className="rounded bg-gray-100 px-1">lmdu.ready()</code>. See that file for the API.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Access</div>
        <div className="space-y-1.5 text-sm">
          {(
            [
              ["none", "No document access", "Only its own settings."],
              ["read", "Read this table", "The records this widget shows, as each viewer sees them."],
              ["full", "Full document access", "Every table, and adding, changing and removing records of this table with the viewer's own permissions."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={clsx("flex items-start gap-2 rounded-md p-1.5", access === value && "bg-gray-50")}>
              <input type="radio" className="mt-1" disabled={!canEdit} checked={access === value} onChange={() => setOpt({ customAccess: value })} />
              <span>
                <span className="font-medium">{label}</span>
                <span className="block text-xs text-gray-500">{hint}</span>
              </span>
            </label>
          ))}
          {access === "full" && kind === "url" && (
            <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">Only give full access to pages you trust: they can change data as whoever is looking at them.</p>
          )}
          {declared && ACCESS_RANK[access] < ACCESS_RANK[declared.requires] && (
            <p className="text-xs text-amber-700">The widget asks for {declared.requires === "full" ? "full document" : "read table"} access.</p>
          )}
        </div>
      </div>
      {declared && declared.columns.length > 0 && (
        <div className="border-b border-gray-100 px-4 py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Columns</div>
          <div className="space-y-2">
            {declared.columns.map((d) => {
              const m = o.customMapping?.[d.name];
              const fits = cols.filter((c) => typeOk(c, d));
              return (
                <div key={d.name}>
                  <div className="mb-1 text-xs text-gray-500" title={d.description}>
                    {d.title || d.name}
                    {d.optional ? " (optional)" : ""}
                  </div>
                  {d.multiple ? (
                    <div className="space-y-0.5">
                      {fits.map((c) => {
                        const list = Array.isArray(m) ? m : m ? [m] : [];
                        return (
                          <label key={c.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              disabled={!canEdit}
                              checked={list.includes(c.id)}
                              onChange={(e) => setMap(d.name, e.target.checked ? [...list, c.id] : list.filter((x) => x !== c.id))}
                            />
                            {c.label || c.col_id}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <Select value={typeof m === "string" ? m : ""} disabled={!canEdit} onChange={(e) => setMap(d.name, e.target.value || null)}>
                      <option value="">{d.optional ? "None" : "Choose a column…"}</option>
                      {fits.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label || c.col_id}
                        </option>
                      ))}
                    </Select>
                  )}
                  {d.description && <p className="mt-0.5 text-[11px] text-gray-400">{d.description}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
