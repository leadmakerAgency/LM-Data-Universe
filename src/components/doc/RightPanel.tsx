"use client";

import clsx from "clsx";
import { ArrowDownAZ, ArrowUpAZ, Eye, EyeOff, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Input, Label, Select, useDialogs } from "@/components/ui";
import { CellContent } from "./CellContent";
import { linkOptions } from "./AddWidgetDialog";
import { CHOICE_PALETTE, DATE_FORMATS, displayValue } from "@/lib/format";
import { FUNCTION_NAMES } from "@/lib/formula/functions";
import { FormulaError } from "@/lib/formula/values";
import { labelToIdent } from "@/lib/ids";
import { COLUMN_TYPES, WIDGET_TYPES, type ColumnOptions, type ColumnType, type DocColumn, type DocWidget, type WidgetOptions, type WidgetType } from "@/lib/types";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

export function RightPanel() {
  const panel = useUi((s) => s.panel);
  const openPanel = useUi((s) => s.openPanel);
  const columns = useDoc((s) => s.columns);
  const widgets = useDoc((s) => s.widgets);
  useDoc((s) => s.version);
  if (!panel) return null;
  const col = panel.tab === "column" ? columns.get(panel.colId) : undefined;
  const widget = panel.tab === "widget" ? widgets.get(panel.widgetId) : undefined;
  return (
    <aside className="scroll-thin flex w-80 shrink-0 flex-col overflow-y-auto border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="text-sm font-semibold">{panel.tab === "column" ? "Column" : "Widget"}</div>
        <IconButton onClick={() => openPanel(null)} title="Close panel">
          <X size={16} />
        </IconButton>
      </div>
      {col && <ColumnPanel key={col.id} col={col} focusFormula={panel.tab === "column" && !!panel.focusFormula} />}
      {widget && <WidgetPanel key={widget.id} widget={widget} />}
      {!col && !widget && <p className="p-4 text-sm text-gray-500">This item no longer exists.</p>}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 px-4 py-4">
      <Label className="mb-2">{title}</Label>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

type CommitInputProps = { value: string; onCommit: (v: string) => void; disabled?: boolean; className?: string; mono?: boolean };

/** Text input that commits on blur or Enter; resets when the saved value changes. */
function CommitInput(props: CommitInputProps) {
  return <CommitInputInner key={props.value} {...props} />;
}

function CommitInputInner({ value, onCommit, disabled, className, mono }: CommitInputProps) {
  const [text, setText] = useState(value);
  return (
    <Input
      value={text}
      disabled={disabled}
      className={clsx(mono && "font-mono text-xs", className)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value);
      }}
    />
  );
}

// ------------------------------------------------------------------ column

function ColumnPanel({ col, focusFormula }: { col: DocColumn; focusFormula: boolean }) {
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  const tables = useDoc((s) => s.tables);
  const update = (patch: Partial<DocColumn>) => useDoc.getState().updateColumn(col.id, patch);
  const setOpt = (o: ColumnOptions) => update({ options: o });
  const { confirm } = useDialogs();

  const changeLabel = (label: string) => {
    const synced = col.col_id === labelToIdent(col.label || col.col_id);
    void update(synced && label.trim() ? { label, col_id: labelToIdent(label) } : { label });
  };

  const changeType = (type: ColumnType) => {
    const patch: Partial<DocColumn> = { type };
    const options: ColumnOptions = {};
    if ((type === "Choice" || type === "ChoiceList") && !col.options.choices?.length) {
      options.choices = existingValues(col).slice(0, 30);
    }
    if ((type === "Ref" || type === "RefList") && !col.options.refTable) {
      const other = [...tables.values()].find((t) => t.id !== col.table_ref) ?? [...tables.values()][0];
      if (other) {
        options.refTable = other.id;
        options.visibleCol = tableColumns(other.id)[0]?.id ?? null;
      }
    }
    if (Object.keys(options).length) patch.options = options;
    void update(patch);
  };

  return (
    <div className="text-sm">
      <Section title="Label">
        <CommitInput value={col.label} onCommit={changeLabel} disabled={!canEdit} />
        <div>
          <div className="mb-1 text-xs text-gray-500">Column ID (used in formulas)</div>
          <CommitInput value={col.col_id} onCommit={(v) => update({ col_id: v })} disabled={!canEdit} mono />
        </div>
      </Section>

      <Section title="Column behavior">
        <div className="flex rounded-md bg-gray-100 p-0.5 text-xs font-medium">
          {[
            [false, "Data"],
            [true, "Formula"],
          ].map(([v, label]) => (
            <button
              key={String(v)}
              disabled={!canEdit}
              onClick={() => col.is_formula !== v && update({ is_formula: v as boolean, formula: v ? col.formula : col.formula })}
              className={clsx("flex-1 rounded px-2 py-1.5", col.is_formula === v ? "bg-white shadow-sm" : "text-gray-500")}
            >
              {label as string}
            </button>
          ))}
        </div>
        {col.is_formula ? (
          <FormulaEditor key={col.formula} col={col} autoFocus={focusFormula} canEdit={canEdit} />
        ) : (
          <p className="text-xs text-gray-500">
            Data columns hold values you type, paste or import. Switch to Formula to compute values; typing “=” into an empty column does the same.
          </p>
        )}
      </Section>

      <Section title="Column type">
        <Select value={col.type} onChange={(e) => changeType(e.target.value as ColumnType)} disabled={!canEdit}>
          {COLUMN_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.icon} {t.label}
            </option>
          ))}
        </Select>
        <TypeOptions col={col} setOpt={setOpt} canEdit={canEdit} />
      </Section>

      {canEdit && (
        <div className="px-4 py-4">
          <Button
            variant="ghost"
            className="text-red-600 hover:bg-red-50"
            onClick={async () => {
              const ok = await confirm({
                title: `Delete column “${col.label || col.col_id}”?`,
                message: "Its data is removed from every view of this table. This cannot be undone.",
                confirmLabel: "Delete column",
                danger: true,
              });
              if (ok) {
                await useDoc.getState().deleteColumn(col.id);
                useUi.getState().openPanel(null);
              }
            }}
          >
            <Trash2 size={14} /> Delete column
          </Button>
        </div>
      )}
    </div>
  );
}

function existingValues(col: DocColumn): string[] {
  const { engine } = getDerived();
  const ctx = displayCtx();
  const seen = new Set<string>();
  for (const id of engine.rowIds(col.table_ref)) {
    const v = engine.safeValue(col, id);
    if (v instanceof FormulaError) continue;
    const parts = Array.isArray(v) ? v.map(String) : [displayValue(ctx, col, v)];
    for (const p of parts) if (p.trim()) seen.add(p.trim());
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function FormulaEditor({ col, autoFocus, canEdit }: { col: DocColumn; autoFocus: boolean; canEdit: boolean }) {
  const [text, setText] = useState(col.formula);
  const ref = useRef<HTMLTextAreaElement>(null);
  const siblings = tableColumns(col.table_ref).filter((c) => c.id !== col.id);
  const tables = useDoc((s) => s.tables);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const preview = useMemo(() => {
    const { engine } = getDerived();
    const first = engine.rowIds(col.table_ref)[0];
    if (first === undefined || !text.trim()) return null;
    return { value: engine.evaluate(text, col.table_ref, first) };
  }, [text, col.table_ref]);

  const insert = (snippet: string) => {
    const el = ref.current;
    if (!el) return setText(text + snippet);
    const start = el.selectionStart;
    const next = text.slice(0, start) + snippet + text.slice(el.selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const dirty = text !== col.formula;
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-gray-300 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
        <div className="flex">
          <span className="select-none py-2 pl-2 font-mono text-xs font-semibold text-brand-600">=</span>
          <textarea
            ref={ref}
            value={text}
            disabled={!canEdit}
            rows={Math.min(10, Math.max(3, text.split("\n").length))}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
                e.preventDefault();
                if (dirty) void useDoc.getState().updateColumn(col.id, { formula: text });
              }
            }}
            spellCheck={false}
            placeholder="$Price * $Quantity"
            className="w-full resize-none bg-transparent p-2 font-mono text-xs outline-none"
          />
        </div>
      </div>
      {preview && (
        <div className="flex items-center gap-2 rounded-md bg-gray-50 px-2 py-1.5 text-xs">
          <span className="text-gray-500">First row:</span>
          <span className="flex min-w-0 flex-1">
            <CellContent col={{ ...col, type: col.type }} value={preview.value} />
          </span>
          {preview.value instanceof FormulaError && <span className="truncate text-red-600" title={preview.value.message}>{preview.value.message}</span>}
        </div>
      )}
      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => useDoc.getState().updateColumn(col.id, { formula: text })}>
            Apply
          </Button>
          <Button size="sm" disabled={!dirty} onClick={() => setText(col.formula)}>
            Cancel
          </Button>
          <span className="self-center text-[11px] text-gray-400">Enter to apply, Shift+Enter for new line</span>
        </div>
      )}
      <div className="text-xs text-gray-500">
        <div className="mb-1 font-medium">Columns</div>
        <div className="flex flex-wrap gap-1">
          {siblings.map((c) => (
            <button key={c.id} onClick={() => insert(`$${c.col_id}`)} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] hover:bg-brand-100">
              ${c.col_id}
            </button>
          ))}
        </div>
        <div className="mb-1 mt-2 font-medium">Tables</div>
        <div className="flex flex-wrap gap-1">
          {[...tables.values()].map((t) => (
            <button
              key={t.id}
              onClick={() => insert(`${t.table_id}.lookupRecords(${tableColumns(t.id).find((c) => c.options.refTable === col.table_ref)?.col_id ?? "Column"}=$id)`)}
              className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] hover:bg-brand-100"
            >
              {t.table_id}
            </button>
          ))}
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer font-medium">Functions ({FUNCTION_NAMES.length})</summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {FUNCTION_NAMES.map((f) => (
              <button key={f} onClick={() => insert(`${f}()`)} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] hover:bg-brand-100">
                {f}
              </button>
            ))}
          </div>
          <p className="mt-2 leading-relaxed">
            Examples: <code className="font-mono">$Qty * $Price</code>, <code className="font-mono">$Customer.Name</code>,{" "}
            <code className="font-mono">SUM(Orders.lookupRecords(Customer=$id).Total)</code>,{" "}
            <code className="font-mono">&quot;Yes&quot; if $Paid else &quot;No&quot;</code>, <code className="font-mono">DATEADD($Start, days=30)</code>
          </p>
        </details>
      </div>
    </div>
  );
}

function TypeOptions({ col, setOpt, canEdit }: { col: DocColumn; setOpt: (o: ColumnOptions) => void; canEdit: boolean }) {
  const tables = useDoc((s) => s.tables);
  const o = col.options;
  if (col.type === "Numeric" || col.type === "Int") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-1 text-xs text-gray-500">Format</div>
          <Select value={o.numMode ?? "decimal"} disabled={!canEdit} onChange={(e) => setOpt({ numMode: e.target.value as ColumnOptions["numMode"] })}>
            <option value="decimal">Number</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
          </Select>
        </div>
        {col.type === "Numeric" && (
          <div>
            <div className="mb-1 text-xs text-gray-500">Decimals</div>
            <Select
              value={o.decimals ?? ""}
              disabled={!canEdit}
              onChange={(e) => setOpt({ decimals: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">Auto</option>
              {[0, 1, 2, 3, 4].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </div>
        )}
        {o.numMode === "currency" && (
          <div>
            <div className="mb-1 text-xs text-gray-500">Currency</div>
            <CommitInput value={o.currency ?? "USD"} disabled={!canEdit} onCommit={(v) => setOpt({ currency: v.toUpperCase().slice(0, 3) })} />
          </div>
        )}
      </div>
    );
  }
  if (col.type === "Date" || col.type === "DateTime") {
    return (
      <div>
        <div className="mb-1 text-xs text-gray-500">Date format</div>
        <Select value={o.dateFormat ?? "YYYY-MM-DD"} disabled={!canEdit} onChange={(e) => setOpt({ dateFormat: e.target.value })}>
          {DATE_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (col.type === "Choice" || col.type === "ChoiceList") {
    return <ChoicesEditor col={col} setOpt={setOpt} canEdit={canEdit} />;
  }
  if (col.type === "Ref" || col.type === "RefList") {
    const target = o.refTable ?? "";
    return (
      <div className="space-y-2">
        <div>
          <div className="mb-1 text-xs text-gray-500">Points to table</div>
          <Select
            value={target}
            disabled={!canEdit}
            onChange={(e) => setOpt({ refTable: e.target.value, visibleCol: tableColumns(e.target.value)[0]?.id ?? null })}
          >
            <option value="" disabled>
              Choose a table
            </option>
            {[...tables.values()].map((t) => (
              <option key={t.id} value={t.id}>
                {t.table_id}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-xs text-gray-500">Show column</div>
          <Select value={o.visibleCol ?? ""} disabled={!canEdit || !target} onChange={(e) => setOpt({ visibleCol: e.target.value || null })}>
            {tableColumns(target).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.col_id}
              </option>
            ))}
          </Select>
        </div>
      </div>
    );
  }
  if (col.type === "Text" || col.type === "Any") {
    return (
      <div className="flex items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={!!o.wrap} disabled={!canEdit} onChange={(e) => setOpt({ wrap: e.target.checked })} /> Wrap text
        </label>
        <Select className="h-8 w-28" value={o.alignment ?? "left"} disabled={!canEdit} onChange={(e) => setOpt({ alignment: e.target.value as ColumnOptions["alignment"] })}>
          <option value="left">Align left</option>
          <option value="center">Center</option>
          <option value="right">Align right</option>
        </Select>
      </div>
    );
  }
  return null;
}

function ChoicesEditor({ col, setOpt, canEdit }: { col: DocColumn; setOpt: (o: ColumnOptions) => void; canEdit: boolean }) {
  const choices = col.options.choices ?? [];
  const [draft, setDraft] = useState("");
  const colors = col.options.choiceColors ?? {};
  const add = () => {
    const v = draft.trim();
    if (!v || choices.includes(v)) return;
    setOpt({ choices: [...choices, v] });
    setDraft("");
  };
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {choices.map((c, i) => (
          <li key={c} className="flex items-center gap-2">
            <input
              type="color"
              disabled={!canEdit}
              value={colors[c] ?? CHOICE_PALETTE[i % CHOICE_PALETTE.length]}
              onChange={(e) => setOpt({ choiceColors: { ...colors, [c]: e.target.value } })}
              className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            <span className="flex-1 truncate rounded px-2 py-0.5 text-xs" style={{ background: colors[c] ?? CHOICE_PALETTE[i % CHOICE_PALETTE.length] }}>
              {c}
            </span>
            {canEdit && (
              <IconButton className="h-6 w-6" onClick={() => setOpt({ choices: choices.filter((x) => x !== c) })}>
                <X size={12} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex gap-2">
          <Input className="h-8" placeholder="New choice" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button size="sm" onClick={add}>
            Add
          </Button>
        </div>
      )}
      {canEdit && (
        <button
          className="text-xs text-brand-600 hover:underline"
          onClick={() => setOpt({ choices: [...new Set([...choices, ...existingValues(col)])] })}
        >
          Add choices from existing values
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ widget

function defaultOptionsFor(type: WidgetType, tableRef: string | null): WidgetOptions {
  const cols = tableColumns(tableRef);
  if (type === "chart") {
    const numeric = cols.filter((c) => c.type === "Numeric" || c.type === "Int");
    return { chartType: "bar", xCol: cols.find((c) => !numeric.includes(c))?.id ?? null, yCols: numeric.slice(0, 1).map((c) => c.id), aggregate: "sum" };
  }
  if (type === "summary") return { groupBy: cols.slice(0, 1).map((c) => c.id) };
  if (type === "form") return { fields: cols.filter((c) => !c.is_formula && c.type !== "Ref" && c.type !== "RefList").map((c) => ({ col: c.id })) };
  return {};
}

function WidgetPanel({ widget }: { widget: DocWidget }) {
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  const widgets = useDoc((s) => s.widgets);
  const cols = tableColumns(widget.table_ref);
  const o = widget.options;
  const update = (patch: Partial<DocWidget>) => useDoc.getState().updateWidget(widget.id, patch);
  const setOpt = (patch: Partial<WidgetOptions>) => update({ options: patch });

  // Widgets that would not create a linking cycle.
  const candidates = [...widgets.values()].filter((w) => {
    if (w.page_id !== widget.page_id || w.id === widget.id) return false;
    let cur: DocWidget | undefined = w;
    const seen = new Set<string>();
    while (cur?.link_source && !seen.has(cur.id)) {
      if (cur.link_source === widget.id) return false;
      seen.add(cur.id);
      cur = widgets.get(cur.link_source);
    }
    return true;
  });
  const links = linkOptions(widget.table_ref, candidates);
  const currentLink = widget.link_source ? `${widget.link_source}|${widget.link_col ?? ""}` : "";
  const hidden = new Set(o.hidden ?? []);
  const numeric = cols.filter((c) => c.type === "Numeric" || c.type === "Int");

  return (
    <div className="text-sm">
      <Section title="Widget">
        <div>
          <div className="mb-1 text-xs text-gray-500">Title</div>
          <CommitInput value={widget.title} onCommit={(v) => update({ title: v })} disabled={!canEdit} />
        </div>
        <div>
          <div className="mb-1 text-xs text-gray-500">Type</div>
          <Select
            value={widget.type}
            disabled={!canEdit}
            onChange={(e) => {
              const type = e.target.value as WidgetType;
              update({ type, options: { ...defaultOptionsFor(type, widget.table_ref), ...o } });
            }}
          >
            {WIDGET_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="text-xs text-gray-500">
          Data: <span className="font-medium text-gray-700">{widget.table_ref ? useDoc.getState().tables.get(widget.table_ref)?.table_id : "—"}</span>
        </div>
      </Section>

      <Section title="Select by">
        <Select
          value={currentLink}
          disabled={!canEdit}
          onChange={(e) => {
            const l = links.find((x) => x.key === e.target.value);
            update({ link_source: l?.sourceId ?? null, link_col: l?.linkCol ?? null });
          }}
        >
          <option value="">Not linked</option>
          {links.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </Select>
        {!links.length && <p className="text-xs text-gray-500">Add a Reference column pointing to another widget&apos;s table to link them.</p>}
      </Section>

      {(widget.type === "table" || widget.type === "card" || widget.type === "card_list") && (
        <Section title="Visible columns">
          <ul className="space-y-0.5">
            {cols.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <button
                  onClick={() => setOpt({ hidden: hidden.has(c.id) ? [...hidden].filter((x) => x !== c.id) : [...hidden, c.id] })}
                  className="text-gray-400 hover:text-gray-700"
                  title={hidden.has(c.id) ? "Show" : "Hide"}
                >
                  {hidden.has(c.id) ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <span className={clsx("truncate", hidden.has(c.id) && "text-gray-400 line-through")}>{c.label || c.col_id}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {widget.type !== "form" && widget.type !== "summary" && (
        <Section title="Sort">
          {(o.sort ?? []).map((s, i) => {
            const c = cols.find((x) => x.id === s.col);
            return (
              <div key={s.col} className="flex items-center gap-2">
                <span className="flex-1 truncate">{c?.label || c?.col_id || "?"}</span>
                <IconButton
                  title="Toggle direction"
                  onClick={() => setOpt({ sort: (o.sort ?? []).map((x, k) => (k === i ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x)) })}
                >
                  {s.dir === "asc" ? <ArrowDownAZ size={14} /> : <ArrowUpAZ size={14} />}
                </IconButton>
                <IconButton title="Remove" onClick={() => setOpt({ sort: (o.sort ?? []).filter((_, k) => k !== i) })}>
                  <X size={13} />
                </IconButton>
              </div>
            );
          })}
          <Select
            value=""
            onChange={(e) => e.target.value && setOpt({ sort: [...(o.sort ?? []), { col: e.target.value, dir: "asc" }] })}
          >
            <option value="">+ Add sort column</option>
            {cols
              .filter((c) => !(o.sort ?? []).some((s) => s.col === c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || c.col_id}
                </option>
              ))}
          </Select>
          {Object.keys(o.filters ?? {}).length > 0 && (
            <div className="flex items-center justify-between text-xs text-gray-600">
              {Object.keys(o.filters ?? {}).length} column filter(s) active
              <button className="text-brand-600 hover:underline" onClick={() => setOpt({ filters: {} })}>
                Clear filters
              </button>
            </div>
          )}
        </Section>
      )}

      {widget.type === "chart" && (
        <Section title="Chart">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs text-gray-500">Chart type</div>
              <Select value={o.chartType ?? "bar"} onChange={(e) => setOpt({ chartType: e.target.value as WidgetOptions["chartType"] })}>
                <option value="bar">Bar</option>
                <option value="line">Line</option>
                <option value="area">Area</option>
                <option value="pie">Pie</option>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">Values</div>
              <Select value={o.aggregate ?? "sum"} onChange={(e) => setOpt({ aggregate: e.target.value as WidgetOptions["aggregate"] })}>
                <option value="sum">Sum per group</option>
                <option value="avg">Average per group</option>
                <option value="count">Count of records</option>
                <option value="none">Each record</option>
              </Select>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">X axis / categories</div>
            <Select value={o.xCol ?? ""} onChange={(e) => setOpt({ xCol: e.target.value || null })}>
              <option value="">Row number</option>
              {cols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || c.col_id}
                </option>
              ))}
            </Select>
          </div>
          {o.aggregate !== "count" && (
            <div>
              <div className="mb-1 text-xs text-gray-500">Series</div>
              {numeric.length === 0 && <p className="text-xs text-gray-500">No numeric columns in this table.</p>}
              {numeric.map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={(o.yCols ?? []).includes(c.id)}
                    onChange={(e) =>
                      setOpt({ yCols: e.target.checked ? [...(o.yCols ?? []), c.id] : (o.yCols ?? []).filter((x) => x !== c.id) })
                    }
                  />
                  {c.label || c.col_id}
                </label>
              ))}
            </div>
          )}
          {(o.chartType === "bar" || o.chartType === "area") && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!o.stacked} onChange={(e) => setOpt({ stacked: e.target.checked })} /> Stack series
            </label>
          )}
        </Section>
      )}

      {widget.type === "summary" && (
        <Section title="Group by">
          {cols.map((c) => (
            <label key={c.id} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={(o.groupBy ?? []).includes(c.id)}
                onChange={(e) =>
                  setOpt({ groupBy: e.target.checked ? [...(o.groupBy ?? []), c.id] : (o.groupBy ?? []).filter((x) => x !== c.id) })
                }
              />
              {c.label || c.col_id}
            </label>
          ))}
          <p className="text-xs text-gray-500">Numeric columns are totalled for each group. Link a table to this summary to see the records of the selected group.</p>
        </Section>
      )}

      {widget.type === "form" && <FormSettings widget={widget} setOpt={setOpt} canEdit={canEdit} />}
    </div>
  );
}

function FormSettings({ widget, setOpt, canEdit }: { widget: DocWidget; setOpt: (o: Partial<WidgetOptions>) => void; canEdit: boolean }) {
  const o = widget.options;
  const cols = tableColumns(widget.table_ref).filter((c) => !c.is_formula && c.type !== "Ref" && c.type !== "RefList");
  const fields = o.fields ?? [];
  const share = useDoc((s) => s.formShares.get(widget.id));
  return (
    <>
      <Section title="Form text">
        <div>
          <div className="mb-1 text-xs text-gray-500">Title</div>
          <CommitInput value={o.formTitle ?? ""} disabled={!canEdit} onCommit={(v) => setOpt({ formTitle: v })} />
        </div>
        <div>
          <div className="mb-1 text-xs text-gray-500">Description</div>
          <textarea
            defaultValue={o.formDescription ?? ""}
            disabled={!canEdit}
            onBlur={(e) => e.target.value !== (o.formDescription ?? "") && setOpt({ formDescription: e.target.value })}
            rows={3}
            className="w-full rounded-md border border-gray-300 p-2 text-sm outline-none focus:border-brand-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 text-xs text-gray-500">Button</div>
            <CommitInput value={o.submitLabel ?? "Submit"} disabled={!canEdit} onCommit={(v) => setOpt({ submitLabel: v })} />
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">Thank-you text</div>
            <CommitInput value={o.successMessage ?? ""} disabled={!canEdit} onCommit={(v) => setOpt({ successMessage: v })} />
          </div>
        </div>
      </Section>
      <Section title="Fields">
        {cols.map((c) => {
          const f = fields.find((x) => x.col === c.id);
          return (
            <div key={c.id} className="rounded-md border border-gray-100 p-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={!!f}
                  onChange={(e) => setOpt({ fields: e.target.checked ? [...fields, { col: c.id }] : fields.filter((x) => x.col !== c.id) })}
                />
                <span className="flex-1 truncate font-medium">{c.label || c.col_id}</span>
                {f && (
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={!!f.required}
                      onChange={(e) => setOpt({ fields: fields.map((x) => (x.col === c.id ? { ...x, required: e.target.checked } : x)) })}
                    />
                    Required
                  </label>
                )}
              </label>
              {f && (
                <CommitInput
                  className="mt-1.5 h-8 text-xs"
                  value={f.help ?? ""}
                  disabled={!canEdit}
                  onCommit={(v) => setOpt({ fields: fields.map((x) => (x.col === c.id ? { ...x, help: v } : x)) })}
                />
              )}
            </div>
          );
        })}
        <p className="text-xs text-gray-500">Formula and Reference columns can&apos;t be filled in from public forms.</p>
      </Section>
      {canEdit && (
        <Section title="Sharing">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!share?.is_active} onChange={(e) => useDoc.getState().setFormShare(widget.id, e.target.checked)} />
            Published: anyone with the link can submit
          </label>
        </Section>
      )}
    </>
  );
}
