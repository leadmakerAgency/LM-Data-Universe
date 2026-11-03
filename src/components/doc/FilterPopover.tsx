"use client";

import { useMemo, useState } from "react";
import { Button, Input, Popover } from "@/components/ui";
import type { ColumnFilter, DocColumn, DocWidget } from "@/lib/types";
import { filterText, widgetRows } from "@/lib/view";

/** Value checklist (and optional range) filter for one column of a widget. */
export function FilterPopover({
  anchor,
  widget,
  col,
  onClose,
  onApply,
}: {
  anchor: HTMLElement | null;
  widget: DocWidget;
  col: DocColumn;
  onClose: () => void;
  onApply: (filters: Record<string, ColumnFilter>) => void;
}) {
  const current = widget.options.filters?.[col.id] ?? {};
  const [excluded, setExcluded] = useState<Set<string>>(new Set(current.exclude ?? []));
  const [min, setMin] = useState(current.min !== undefined && current.min !== null ? String(current.min) : "");
  const [max, setMax] = useState(current.max !== undefined && current.max !== null ? String(current.max) : "");
  const [query, setQuery] = useState("");
  const ranged = ["Numeric", "Int", "Date", "DateTime"].includes(col.type);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of widgetRows(widget, { ignoreFilterFor: col.id }).ids) {
      const t = filterText(col, id);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    for (const v of excluded) if (!m.has(v)) m.set(v, 0);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [widget, col, excluded]);

  const shown = counts.filter(([v]) => v.toLowerCase().includes(query.toLowerCase()));

  const apply = () => {
    const filters = { ...(widget.options.filters ?? {}) };
    const next: ColumnFilter = {};
    if (excluded.size) next.exclude = [...excluded];
    if (ranged && min !== "") next.min = col.type.startsWith("Date") ? min : Number(min);
    if (ranged && max !== "") next.max = col.type.startsWith("Date") ? max : Number(max);
    if (Object.keys(next).length) filters[col.id] = next;
    else delete filters[col.id];
    onApply(filters);
    onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="w-72 p-3">
      <div className="mb-2 text-sm font-medium">Filter {col.label || col.col_id}</div>
      <Input placeholder="Search values" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8" />
      <div className="mt-2 flex gap-3 text-xs">
        <button className="text-brand-600 hover:underline" onClick={() => setExcluded(new Set())}>
          All
        </button>
        <button className="text-brand-600 hover:underline" onClick={() => setExcluded(new Set(counts.map(([v]) => v)))}>
          None
        </button>
      </div>
      <ul className="scroll-thin mt-2 max-h-56 overflow-y-auto">
        {shown.map(([v, n]) => (
          <li key={v}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50">
              <input
                type="checkbox"
                checked={!excluded.has(v)}
                onChange={(e) => {
                  const next = new Set(excluded);
                  if (e.target.checked) next.delete(v);
                  else next.add(v);
                  setExcluded(next);
                }}
              />
              <span className="flex-1 truncate">{v === "" ? <em className="text-gray-400">blank</em> : v}</span>
              <span className="text-xs text-gray-400">{n}</span>
            </label>
          </li>
        ))}
      </ul>
      {ranged && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input className="h-8" placeholder="Min" type={col.type.startsWith("Date") ? "date" : "number"} value={min} onChange={(e) => setMin(e.target.value)} />
          <Input className="h-8" placeholder="Max" type={col.type.startsWith("Date") ? "date" : "number"} value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={apply}>
          Apply
        </Button>
      </div>
    </Popover>
  );
}
