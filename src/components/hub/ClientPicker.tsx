"use client";

// Choosing a client: a button showing the current one ("All clients"), opening
// a searchable list with how many records each client has in this section.
import clsx from "clsx";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover } from "@/components/ui";
import { RecordRef, RecordSet } from "@engine/values";
import type { DocColumn } from "@/lib/types";
import { getDerived, useDoc } from "@/store/docStore";
import { tileTitleText } from "../doc/RecordTile";

export interface ClientCount {
  id: number;
  name: string;
  count: number;
}

/** Every client with the number of records of `table` pointing at it (through `col`). */
export function clientCounts(clientsTable: string, col: DocColumn | undefined): ClientCount[] {
  const { engine } = getDerived();
  const counts = new Map<number, number>();
  if (col) {
    for (const id of engine.rowIds(col.table_ref)) {
      const v = engine.safeValue(col, id);
      const refs = v instanceof RecordRef ? (v.rowId ? [v.rowId] : []) : v instanceof RecordSet ? v.ids : [];
      for (const r of refs) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  }
  return engine
    .rowIds(clientsTable)
    .map((id) => ({ id, name: tileTitleText(clientsTable, id, {}), count: counts.get(id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function ClientPicker({ clientsTable, col, value, onChange }: { clientsTable: string; col: DocColumn | undefined; value: number | null; onChange: (id: number | null) => void }) {
  const version = useDoc((s) => s.version);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => clientCounts(clientsTable, col), [clientsTable, col, version]);
  const current = value ? list.find((c) => c.id === value) : undefined;
  const shown = list.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <span className="inline-flex items-center">
        <button
          className={clsx("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm", value ? "border-brand-300 bg-brand-50 text-brand-800" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50")}
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label="Client"
        >
          <span className="text-gray-500">Client:</span>
          <span className="max-w-48 truncate font-medium">{current?.name ?? (value ? `#${value}` : "All clients")}</span>
          <ChevronDown size={13} className="text-gray-400" />
        </button>
        {value !== null && (
          <button className="ml-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Show all clients" onClick={() => onChange(null)}>
            <X size={13} />
          </button>
        )}
      </span>
      <Popover anchor={anchor} onClose={() => setAnchor(null)}>
        <div className="w-72">
          <div className="relative border-b border-gray-100 p-2">
            <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client" className="h-7 w-full rounded border border-gray-300 pl-7 pr-2 text-sm outline-none focus:border-brand-500" />
          </div>
          <div className="scroll-thin max-h-72 overflow-y-auto py-1">
            <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-100" onClick={() => (onChange(null), setAnchor(null))}>
              <span className="w-4">{value === null && <Check size={13} className="text-brand-600" />}</span>
              <span className="flex-1">All clients</span>
            </button>
            {shown.map((c) => (
              <button key={c.id} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-100" onClick={() => (onChange(c.id), setAnchor(null), setQ(""))}>
                <span className="w-4">{value === c.id && <Check size={13} className="text-brand-600" />}</span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {col && <span className="text-xs text-gray-400">{c.count}</span>}
              </button>
            ))}
            {!shown.length && <p className="px-3 py-2 text-sm text-gray-500">{list.length ? "No client matches." : "No clients yet."}</p>}
          </div>
        </div>
      </Popover>
    </>
  );
}

/** The list of clients beside a section, like mail folders. */
export function ClientRail({ clientsTable, col, value, onChange }: { clientsTable: string; col: DocColumn | undefined; value: number | null; onChange: (id: number | null) => void }) {
  const version = useDoc((s) => s.version);
  const [q, setQ] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => clientCounts(clientsTable, col), [clientsTable, col, version]);
  const total = list.reduce((n, c) => n + c.count, 0);
  const shown = list.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-gray-100 bg-white">
      <div className="p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client" aria-label="Find a client" className="h-7 w-full rounded border border-gray-200 px-2 text-xs outline-none focus:border-brand-500" />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <button className={clsx("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm", value === null ? "bg-brand-50 font-medium text-brand-700" : "hover:bg-gray-100")} onClick={() => onChange(null)}>
          <span className="flex-1">All clients</span>
          <span className="text-xs text-gray-400">{total}</span>
        </button>
        {shown.map((c) => (
          <button key={c.id} className={clsx("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm", value === c.id ? "bg-brand-50 font-medium text-brand-700" : "text-gray-700 hover:bg-gray-100")} onClick={() => onChange(c.id)}>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-xs text-gray-400">{c.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
