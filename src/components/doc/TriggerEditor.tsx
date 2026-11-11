"use client";

import clsx from "clsx";
import { useState } from "react";
import { Button } from "@/components/ui";
import type { DocColumn } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";

/**
 * Trigger formula for a data column: runs when a record is added and/or when
 * chosen fields change, and stores its result as data. Used for timestamps
 * (NOW()), authorship (user.Email) and cleaning up input ($Name.strip()).
 */
export function TriggerEditor({ col, canEdit }: { col: DocColumn; canEdit: boolean }) {
  const t = col.options.trigger;
  const active = !!t && (!!t.onNew || !!t.onChange) && !!col.formula.trim();
  const [open, setOpen] = useState(active);
  const [formula, setFormula] = useState(col.formula);
  const [onNew, setOnNew] = useState(t?.onNew ?? true);
  const [mode, setMode] = useState<"none" | "any" | "some">(t?.onChange === "any" ? "any" : Array.isArray(t?.onChange) ? "some" : "none");
  const [cols, setCols] = useState<string[]>(Array.isArray(t?.onChange) ? t!.onChange : []);
  const others = tableColumns(col.table_ref).filter((c) => c.id !== col.id && !c.is_formula);

  if (!open) {
    return canEdit ? (
      <button className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(true)}>
        + Set trigger formula (e.g. a timestamp or “created by”)
      </button>
    ) : null;
  }

  const save = () =>
    useDoc.getState().updateColumn(col.id, {
      formula,
      options: {
        ...col.options,
        trigger: { onNew, onChange: mode === "any" ? "any" : mode === "some" && cols.length ? cols : undefined },
      },
    });
  const clear = async () => {
    await useDoc.getState().updateColumn(col.id, { formula: "", options: { ...col.options, trigger: undefined } });
    setOpen(false);
  };
  const dirty =
    formula !== col.formula ||
    onNew !== !!t?.onNew ||
    JSON.stringify(mode === "any" ? "any" : mode === "some" && cols.length ? cols : undefined) !== JSON.stringify(t?.onChange);

  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-2">
      <div className="text-xs font-medium text-gray-700">Trigger formula</div>
      <div className="flex items-start rounded-md border border-gray-300 focus-within:border-brand-500">
        <span className="select-none py-1.5 pl-2 font-mono text-xs font-semibold text-brand-600">=</span>
        <textarea
          value={formula}
          disabled={!canEdit}
          rows={Math.min(6, Math.max(2, formula.split("\n").length))}
          placeholder="NOW()"
          spellCheck={false}
          onChange={(e) => setFormula(e.target.value)}
          className="w-full resize-none bg-transparent p-1.5 font-mono text-xs outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1 text-[11px]">
        {["NOW()", "TODAY()", "user.Email", "user.Name", "$" + (others[0]?.col_id ?? "Name") + ".strip()"].map((ex) => (
          <button key={ex} disabled={!canEdit} onClick={() => setFormula(ex)} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono hover:bg-brand-100">
            {ex}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={onNew} disabled={!canEdit} onChange={(e) => setOnNew(e.target.checked)} /> Apply to new records
      </label>
      <div className="space-y-1 text-xs">
        <div className="text-gray-500">Apply on changes to</div>
        <div className="flex rounded-md bg-gray-100 p-0.5 font-medium">
          {(
            [
              ["none", "Nothing"],
              ["any", "Any field"],
              ["some", "Chosen fields"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              disabled={!canEdit}
              onClick={() => setMode(v)}
              className={clsx("flex-1 rounded px-2 py-1", mode === v ? "bg-white shadow-sm" : "text-gray-500")}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "some" && (
          <div className="flex flex-wrap gap-1">
            {others.map((c) => {
              const on = cols.includes(c.id);
              return (
                <button
                  key={c.id}
                  disabled={!canEdit}
                  onClick={() => setCols(on ? cols.filter((x) => x !== c.id) : [...cols, c.id])}
                  className={clsx("rounded px-1.5 py-0.5", on ? "bg-brand-100 text-brand-800" : "bg-gray-100 text-gray-600")}
                >
                  {c.label || c.col_id}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={!dirty || !formula.trim()} onClick={save}>
            Apply
          </Button>
          <Button size="sm" onClick={clear}>
            Remove trigger
          </Button>
        </div>
      )}
      <p className="text-[11px] text-gray-400">The result is saved as data. Existing records keep their values until the trigger fires for them.</p>
    </div>
  );
}
