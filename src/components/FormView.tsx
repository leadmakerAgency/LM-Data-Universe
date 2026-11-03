"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Button, Input } from "./ui";
import type { CellValue, ColumnOptions, ColumnType } from "@/lib/types";
import { errorMessage } from "@/lib/supabase";

export interface PublicField {
  id: string;
  label: string;
  type: ColumnType;
  options: ColumnOptions;
  required: boolean;
  help: string;
}

export interface PublicForm {
  title: string;
  description: string;
  submitLabel: string;
  successMessage: string;
  fields: PublicField[];
}

function toStored(f: PublicField, v: string | boolean | string[]): CellValue {
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v;
  if (v.trim() === "") return null;
  switch (f.type) {
    case "Numeric":
    case "Int": {
      const n = Number(v);
      return isNaN(n) ? v : f.type === "Int" ? Math.round(n) : n;
    }
    case "DateTime":
      return new Date(v).toISOString();
    default:
      return v;
  }
}

/** Renders a form definition; used for the in-editor preview and the public page. */
export function FormView({
  form,
  onSubmit,
  preview,
}: {
  form: PublicForm;
  onSubmit?: (values: Record<string, CellValue>) => Promise<void>;
  preview?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = (id: string, v: string | boolean | string[]) => setValues((s) => ({ ...s, [id]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (preview || !onSubmit) return;
    for (const f of form.fields) {
      const v = values[f.id];
      if (f.required && (v === undefined || v === "" || (Array.isArray(v) && !v.length))) {
        setError(`“${f.label}” is required.`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const out: Record<string, CellValue> = {};
      for (const f of form.fields) {
        if (values[f.id] !== undefined) out[f.id] = toStored(f, values[f.id]);
      }
      await onSubmit(out);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="py-10 text-center">
        <CheckCircle2 className="mx-auto mb-3 text-emerald-500" size={40} />
        <p className="text-base font-medium">{form.successMessage}</p>
        <Button
          className="mt-6"
          onClick={() => {
            setValues({});
            setDone(false);
          }}
        >
          Submit another response
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">{form.title}</h1>
        {form.description && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{form.description}</p>}
      </div>
      {form.fields.map((f) => {
        const v = values[f.id];
        return (
          <div key={f.id}>
            <label className="mb-1 block text-sm font-medium">
              {f.label}
              {f.required && <span className="ml-0.5 text-red-500">*</span>}
            </label>
            {f.help && <p className="mb-1.5 text-xs text-gray-500">{f.help}</p>}
            {f.type === "Bool" ? (
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={v === true} onChange={(e) => set(f.id, e.target.checked)} /> Yes
              </label>
            ) : f.type === "Choice" ? (
              <div className="flex flex-wrap gap-2">
                {(f.options.choices ?? []).map((c) => (
                  <label key={c} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50">
                    <input type="radio" name={f.id} checked={v === c} onChange={() => set(f.id, c)} /> {c}
                  </label>
                ))}
              </div>
            ) : f.type === "ChoiceList" ? (
              <div className="flex flex-wrap gap-2">
                {(f.options.choices ?? []).map((c) => {
                  const list = Array.isArray(v) ? v : [];
                  return (
                    <label key={c} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={list.includes(c)}
                        onChange={(e) => set(f.id, e.target.checked ? [...list, c] : list.filter((x) => x !== c))}
                      />{" "}
                      {c}
                    </label>
                  );
                })}
              </div>
            ) : f.type === "Text" && f.options.wrap ? (
              <textarea
                value={(v as string) ?? ""}
                onChange={(e) => set(f.id, e.target.value)}
                rows={4}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            ) : (
              <Input
                value={(v as string) ?? ""}
                onChange={(e) => set(f.id, e.target.value)}
                type={f.type === "Numeric" || f.type === "Int" ? "number" : f.type === "Date" ? "date" : f.type === "DateTime" ? "datetime-local" : "text"}
                step={f.type === "Numeric" ? "any" : undefined}
              />
            )}
          </div>
        );
      })}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <Button variant="primary" disabled={busy || preview} className="min-w-28">
        {busy ? "Sending…" : form.submitLabel}
      </Button>
      {preview && <p className="text-xs text-gray-400">Preview: submissions are made from the shared link.</p>}
    </form>
  );
}
