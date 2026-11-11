"use client";

import clsx from "clsx";
import { CheckCircle2, Loader2, Paperclip, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button, Input } from "./ui";
import { Markdown } from "./doc/Markdown";
import { formatBytes } from "@/lib/attachments";
import {
  MAX_FORM_UPLOAD_BYTES,
  isFilled,
  publicItems,
  toStored,
  type FormInputValue,
  type PublicForm,
  type PublicFormField,
  type PublicFormItem,
} from "@/lib/forms";
import type { CellValue } from "@/lib/types";
import { errorMessage } from "@/lib/supabase";

export type { PublicForm } from "@/lib/forms";

export interface UploadedFile {
  key: string;
  name: string;
  size: number;
  /** Upload id once the file is stored. */
  id?: string;
  error?: string;
}

export const WIDTH_CLASS: Record<PublicFormField["width"], string> = {
  full: "col-span-6",
  half: "col-span-6 sm:col-span-3",
  third: "col-span-6 sm:col-span-2",
};

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50";

/** Renders a form definition: the public page, and the builder's preview. */
export function FormView({
  form,
  onSubmit,
  onUpload,
  preview,
}: {
  form: PublicForm;
  onSubmit?: (values: Record<string, CellValue>, meta: { hp: string }) => Promise<void>;
  onUpload?: (fieldId: string, file: File) => Promise<string>;
  preview?: boolean;
}) {
  const [values, setValues] = useState<Record<string, FormInputValue>>({});
  const [files, setFiles] = useState<Record<string, UploadedFile[]>>({});
  const [hp, setHp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const fileSeq = useRef(0);
  const items = publicItems(form);
  const fields = items.filter((i): i is PublicFormField => i.kind === "field");
  const uploading = Object.values(files).some((l) => l.some((f) => !f.id && !f.error));

  const set = (id: string, v: FormInputValue) => setValues((s) => ({ ...s, [id]: v }));

  const addFiles = async (field: PublicFormField, list: FileList) => {
    const max = form.maxUploadBytes ?? MAX_FORM_UPLOAD_BYTES;
    for (const file of Array.from(list)) {
      const key = `f${++fileSeq.current}`;
      const entry: UploadedFile = { key, name: file.name, size: file.size };
      if (file.size > max) entry.error = `Larger than ${formatBytes(max)}`;
      else if ((files[field.id]?.length ?? 0) >= 10) entry.error = "Up to 10 files";
      setFiles((s) => ({ ...s, [field.id]: [...(s[field.id] ?? []), entry] }));
      if (entry.error || !onUpload) continue;
      try {
        const id = await onUpload(field.id, file);
        setFiles((s) => ({ ...s, [field.id]: (s[field.id] ?? []).map((f) => (f.key === key ? { ...f, id } : f)) }));
      } catch (e) {
        const msg = errorMessage(e);
        setFiles((s) => ({ ...s, [field.id]: (s[field.id] ?? []).map((f) => (f.key === key ? { ...f, error: msg } : f)) }));
      }
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (preview || !onSubmit) return;
    const all: Record<string, FormInputValue> = { ...values };
    for (const f of fields) {
      if (f.type === "Attachments") all[f.id] = (files[f.id] ?? []).flatMap((x) => (x.id ? [x.id] : []));
    }
    for (const f of fields) {
      if (f.required && !isFilled(all[f.id])) {
        setError(`“${f.label}” is required.`);
        return;
      }
    }
    if (uploading) {
      setError("Please wait until your files have finished uploading.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out: Record<string, CellValue> = {};
      for (const f of fields) {
        if (all[f.id] !== undefined) out[f.id] = toStored(f.type, all[f.id]);
      }
      await onSubmit(out, { hp });
      if (form.redirectUrl && /^https?:\/\//i.test(form.redirectUrl)) {
        window.location.assign(form.redirectUrl);
        return;
      }
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
        <p className="whitespace-pre-wrap text-base font-medium">{form.successMessage}</p>
        {form.submitAnother !== false && (
          <Button
            className="mt-6"
            onClick={() => {
              setValues({});
              setFiles({});
              setDone(false);
            }}
          >
            Submit another response
          </Button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div>
        <h1 className="text-2xl font-semibold">{form.title}</h1>
        {form.description && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{form.description}</p>}
      </div>
      <div className="grid grid-cols-6 gap-x-4 gap-y-5">
        {items.map((item, i) => (
          <FormBlock
            key={i}
            item={item}
            value={item.kind === "field" ? values[item.id] : undefined}
            files={item.kind === "field" ? files[item.id] : undefined}
            onChange={(v) => item.kind === "field" && set(item.id, v)}
            onFiles={(list) => item.kind === "field" && addFiles(item, list)}
            onRemoveFile={(key) => item.kind === "field" && setFiles((s) => ({ ...s, [item.id]: (s[item.id] ?? []).filter((f) => f.key !== key) }))}
            disabled={busy}
            preview={preview}
          />
        ))}
      </div>
      {/* Left empty by people; bots that fill every input reveal themselves. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} name="website" />
        </label>
      </div>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <Button variant="primary" disabled={busy || preview || uploading} className="min-w-28">
        {busy ? "Sending…" : form.submitLabel}
      </Button>
      {preview && <p className="text-xs text-gray-400">Preview: submissions are made from the shared link.</p>}
    </form>
  );
}

/** One block of a form: a field, heading, paragraph or separator. */
export function FormBlock({
  item,
  value,
  files,
  onChange,
  onFiles,
  onRemoveFile,
  disabled,
  preview,
}: {
  item: PublicFormItem;
  value?: FormInputValue;
  files?: UploadedFile[];
  onChange?: (v: FormInputValue) => void;
  onFiles?: (list: FileList) => void;
  onRemoveFile?: (key: string) => void;
  disabled?: boolean;
  preview?: boolean;
}) {
  if (item.kind === "heading") return <h2 className="col-span-6 border-b border-gray-100 pb-1 pt-2 text-lg font-semibold">{item.text}</h2>;
  if (item.kind === "text") {
    return (
      <div className="col-span-6 text-sm text-gray-700">
        <Markdown text={item.text} />
      </div>
    );
  }
  if (item.kind === "separator") return <hr className="col-span-6 border-gray-200" />;
  const labelId = `fl-${item.id}`;
  return (
    <div className={WIDTH_CLASS[item.width] ?? WIDTH_CLASS.full} role="group" aria-labelledby={labelId}>
      <div id={labelId} className="mb-1 block text-sm font-medium">
        {item.label}
        {item.required && <span className="ml-0.5 text-red-500">*</span>}
      </div>
      {item.help && <p className="mb-1.5 whitespace-pre-wrap text-xs text-gray-500">{item.help}</p>}
      <FieldControl
        field={item}
        value={value}
        files={files ?? []}
        onChange={onChange ?? (() => {})}
        onFiles={onFiles ?? (() => {})}
        onRemoveFile={onRemoveFile ?? (() => {})}
        disabled={disabled}
        preview={preview}
        labelId={labelId}
      />
    </div>
  );
}

function FieldControl({
  field: f,
  value: v,
  files,
  onChange,
  onFiles,
  onRemoveFile,
  disabled,
  preview,
  labelId,
}: {
  field: PublicFormField;
  value: FormInputValue | undefined;
  files: UploadedFile[];
  onChange: (v: FormInputValue) => void;
  onFiles: (list: FileList) => void;
  onRemoveFile: (key: string) => void;
  disabled?: boolean;
  preview?: boolean;
  labelId: string;
}) {
  const choices = f.options.choices ?? [];
  switch (f.type) {
    case "Bool":
      return f.display === "switch" ? (
        <button
          type="button"
          role="switch"
          aria-checked={v === true}
          aria-labelledby={labelId}
          disabled={disabled}
          onClick={() => onChange(v !== true)}
          className={clsx("relative h-6 w-11 rounded-full transition", v === true ? "bg-brand-600" : "bg-gray-300")}
        >
          <span className={clsx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", v === true ? "left-[22px]" : "left-0.5")} />
        </button>
      ) : (
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> Yes
        </label>
      );

    case "Choice":
      if (f.display === "dropdown") {
        return (
          <select className={inputCls} aria-labelledby={labelId} value={typeof v === "string" ? v : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        );
      }
      return (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <label key={c} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50">
              <input type="radio" name={f.id} checked={v === c} disabled={disabled} onChange={() => onChange(c)} /> {c}
            </label>
          ))}
        </div>
      );

    case "ChoiceList": {
      const list = Array.isArray(v) ? (v as string[]) : [];
      return (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <label key={c} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50">
              <input
                type="checkbox"
                checked={list.includes(c)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...list, c] : list.filter((x) => x !== c))}
              />{" "}
              {c}
            </label>
          ))}
        </div>
      );
    }

    case "Ref":
      return <RefPicker field={f} value={typeof v === "string" ? v : ""} onChange={onChange} disabled={disabled} labelId={labelId} />;

    case "RefList": {
      const list = Array.isArray(v) ? (v as number[]) : [];
      const opts = f.choices ?? [];
      return (
        <div className="scroll-thin max-h-48 overflow-y-auto rounded-md border border-gray-200 p-1">
          {opts.length === 0 && <p className="px-2 py-1 text-xs text-gray-400">Nothing to choose from yet.</p>}
          {opts.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50">
              <input
                type="checkbox"
                checked={list.includes(o.id)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...list, o.id] : list.filter((x) => x !== o.id))}
              />
              {o.label || <span className="text-gray-400">(blank)</span>}
            </label>
          ))}
        </div>
      );
    }

    case "Attachments":
      return (
        <div className="space-y-1.5">
          {files.map((file) => (
            <div key={file.key} className={clsx("flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm", file.error ? "border-red-200 bg-red-50" : "border-gray-200")}>
              {file.id || file.error ? <Paperclip size={14} className="shrink-0 text-gray-400" /> : <Loader2 size={14} className="shrink-0 animate-spin text-brand-500" />}
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className={clsx("shrink-0 text-xs", file.error ? "text-red-600" : "text-gray-400")}>{file.error ?? formatBytes(file.size)}</span>
              <button type="button" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" onClick={() => onRemoveFile(file.key)} aria-label={`Remove ${file.name}`}>
                <X size={13} />
              </button>
            </div>
          ))}
          <label
            className={clsx(
              "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-gray-300 px-3 py-3 text-sm text-gray-600 hover:border-brand-400 hover:bg-brand-50",
              (disabled || preview) && "pointer-events-none opacity-60",
            )}
          >
            <Paperclip size={14} /> Attach files
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={disabled || preview}
              onChange={(e) => {
                if (e.target.files?.length) onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      );

    default:
      if (f.type === "Text" && f.options.wrap) {
        return <textarea aria-labelledby={labelId} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(e.target.value)} rows={4} disabled={disabled} className={inputCls} />;
      }
      return (
        <Input
          aria-labelledby={labelId}
          value={typeof v === "string" ? v : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          type={f.type === "Numeric" || f.type === "Int" ? "number" : f.type === "Date" ? "date" : f.type === "DateTime" ? "datetime-local" : "text"}
          step={f.type === "Numeric" ? "any" : f.type === "Int" ? 1 : undefined}
        />
      );
  }
}

/** A dropdown of records; with many records, a search box narrows it. */
function RefPicker({
  field,
  value,
  onChange,
  disabled,
  labelId,
}: {
  field: PublicFormField;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  labelId: string;
}) {
  const [q, setQ] = useState("");
  const all = field.choices ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((o) => o.label.toLowerCase().includes(needle) || String(o.id) === value) : all;
  if (field.display === "radio" && all.length <= 30) {
    return (
      <div className="flex flex-wrap gap-2">
        {all.map((o) => (
          <label key={o.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50">
            <input type="radio" name={field.id} checked={value === String(o.id)} disabled={disabled} onChange={() => onChange(String(o.id))} /> {o.label || "(blank)"}
          </label>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {all.length > 15 && (
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className={clsx(inputCls, "pl-8")} disabled={disabled} aria-label={`Search ${field.label}`} />
        </div>
      )}
      <select className={inputCls} aria-labelledby={labelId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all.length ? "Choose…" : "Nothing to choose from yet"}</option>
        {shown.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {o.label || "(blank)"}
          </option>
        ))}
      </select>
    </div>
  );
}
