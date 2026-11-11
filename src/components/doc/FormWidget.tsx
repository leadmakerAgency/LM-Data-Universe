"use client";

import clsx from "clsx";
import { Copy, Eye, ExternalLink, GripVertical, Heading, Minus, Pencil, Pilcrow, Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { FormBlock, FormView, WIDTH_CLASS } from "@/components/FormView";
import { Button, MenuDivider, MenuItem, Popover, Select } from "@/components/ui";
import { displayValue } from "@/lib/format";
import {
  displayChoices,
  formColumn,
  formItemsOf,
  newFormItem,
  type PublicForm,
  type PublicFormField,
  type PublicFormItem,
} from "@/lib/forms";
import { supabase } from "@/lib/supabase";
import { COLUMN_TYPES, type DocColumn, type DocWidget, type FormFieldDisplay, type FormItem } from "@/lib/types";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

/** Choices for a reference field, from the records loaded in the browser. */
function localRefChoices(col: DocColumn): { id: number; label: string }[] {
  const target = col.options.refTable;
  if (!target) return [];
  const { engine } = getDerived();
  const vis = tableColumns(target).find((c) => c.id === col.options.visibleCol);
  const ctx = displayCtx();
  return engine
    .rowIds(target)
    .slice(0, 1000)
    .map((id) => ({ id, label: vis ? displayValue(ctx, vis, engine.safeValue(vis, id)) : `#${id}` }));
}

function publicItem(item: FormItem, cols: DocColumn[]): PublicFormItem | null {
  if (item.kind !== "field") return item.kind === "separator" ? { kind: "separator" } : { kind: item.kind, text: item.text };
  const c = cols.find((x) => x.id === item.col);
  if (!c || !formColumn(c)) return null;
  const field: PublicFormField = {
    kind: "field",
    id: c.id,
    label: item.label?.trim() || c.label || c.col_id,
    type: c.type,
    options: c.options,
    required: !!item.required,
    help: item.help ?? "",
    width: item.width ?? "full",
    display: item.display ?? "",
  };
  if (c.type === "Ref" || c.type === "RefList") field.choices = localRefChoices(c);
  return field;
}

/** Builds the same form definition the public page receives. */
export function formDefinition(widget: DocWidget): PublicForm {
  const cols = tableColumns(widget.table_ref);
  const o = widget.options;
  return {
    title: o.formTitle || widget.title || "Form",
    description: o.formDescription ?? "",
    submitLabel: o.submitLabel || "Submit",
    successMessage: o.successMessage || "Thank you! Your response has been recorded.",
    redirectUrl: o.redirectUrl ?? "",
    submitAnother: o.submitAnother !== false,
    items: formItemsOf(widget)
      .map((i) => publicItem(i, cols))
      .filter((i): i is PublicFormItem => !!i),
  };
}

interface FormStats {
  ok_7d: number;
  refused_7d: number;
  spam_7d: number;
  last_ok: string | null;
  last_refusal: { at: string; outcome: string; detail: string | null } | null;
}

export function FormWidget({ widget }: { widget: DocWidget }) {
  const version = useDoc((s) => s.version);
  const share = useDoc((s) => s.formShares.get(widget.id));
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [stats, setStats] = useState<FormStats | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const form = useMemo(() => formDefinition(widget), [widget, version]);
  const url = share && typeof window !== "undefined" ? `${window.location.origin}/f/${share.token}` : "";
  const editing = canEdit && mode === "edit";

  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    const load = () =>
      supabase()
        .rpc("form_stats", { p_widget: widget.id })
        .then(({ data, error }) => {
          if (!live) return;
          // An older database without form statistics: stop asking.
          if (error?.code === "PGRST202" || /could not find the function/i.test(error?.message ?? "")) window.clearInterval(t);
          else if (!error) setStats(data as FormStats);
        });
    const t = window.setInterval(load, 60_000);
    void load();
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [canEdit, widget.id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs">
        <span className={share?.is_active ? "font-medium text-emerald-700" : "text-gray-500"}>
          {share?.is_active ? "● Published, accepting responses" : "○ Not published"}
        </span>
        {stats && (
          <span
            className="text-gray-500"
            title={
              stats.last_refusal
                ? `Latest refusal (${new Date(stats.last_refusal.at).toLocaleString()}): ${
                    stats.last_refusal.outcome === "rate_limited" ? "too many responses from one visitor" : (stats.last_refusal.detail ?? "")
                  }`
                : undefined
            }
          >
            · {stats.ok_7d} {stats.ok_7d === 1 ? "response" : "responses"} this week
            {stats.refused_7d > 0 && <span className="text-amber-700"> · {stats.refused_7d} refused</span>}
          </span>
        )}
        <div className="flex-1" />
        {canEdit && (
          <div className="flex rounded-md border border-gray-200 p-0.5">
            {(["edit", "preview"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx("flex items-center gap-1 rounded px-2 py-0.5", mode === m ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500 hover:text-gray-800")}
              >
                {m === "edit" ? <Pencil size={11} /> : <Eye size={11} />} {m === "edit" ? "Build" : "Preview"}
              </button>
            ))}
          </div>
        )}
        {canEdit && (
          <Button size="sm" variant={share?.is_active ? "secondary" : "primary"} onClick={() => useDoc.getState().setFormShare(widget.id, !share?.is_active)}>
            {share?.is_active ? "Unpublish" : "Publish form"}
          </Button>
        )}
        {share?.is_active && (
          <>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success("Form link copied");
                } catch {
                  toast.info(`Copy this link: ${url}`);
                }
              }}
            >
              <Copy size={12} /> Copy link
            </Button>
            <a href={url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="ghost">
                <ExternalLink size={12} /> Open
              </Button>
            </a>
          </>
        )}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto bg-gray-50 p-4 sm:p-6">
        <div className="relative mx-auto max-w-2xl rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          {editing ? <FormBuilder widget={widget} form={form} /> : <FormView form={form} preview />}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ builder

function FormBuilder({ widget, form }: { widget: DocWidget; form: PublicForm }) {
  const items = formItemsOf(widget);
  const cols = tableColumns(widget.table_ref);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [addMenu, setAddMenu] = useState<HTMLElement | null>(null);
  const save = (next: FormItem[]) => void useDoc.getState().updateWidget(widget.id, { options: { formItems: next } });
  const patch = (id: string, p: Partial<FormItem>) => save(items.map((i) => (i.id === id ? ({ ...i, ...p } as FormItem) : i)));
  const remove = (id: string) => {
    save(items.filter((i) => i.id !== id));
    if (selected === id) setSelected(null);
  };
  const add = (list: FormItem[]) => {
    const at = selected ? items.findIndex((i) => i.id === selected) + 1 : items.length;
    save([...items.slice(0, at), ...list, ...items.slice(at)]);
    setSelected(list[list.length - 1]?.id ?? null);
    setAddMenu(null);
  };
  const used = new Set(items.flatMap((i) => (i.kind === "field" ? [i.col] : [])));
  const unused = cols.filter((c) => formColumn(c) && !used.has(c.id));

  const drop = () => {
    if (!drag || !over || drag === over.id) return;
    const moving = items.find((i) => i.id === drag);
    if (!moving) return;
    const rest = items.filter((i) => i.id !== drag);
    const at = rest.findIndex((i) => i.id === over.id) + (over.after ? 1 : 0);
    save([...rest.slice(0, at), moving, ...rest.slice(at)]);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{form.title}</h1>
        {form.description ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{form.description}</p>
        ) : (
          <p className="mt-2 text-xs text-gray-400">Title, description, button and thank-you text are in Widget options.</p>
        )}
      </div>
      <div className="grid grid-cols-6 gap-x-4 gap-y-3" onDragEnd={() => (setDrag(null), setOver(null))}>
        {items.map((item) => {
          const shown = publicItem(item, cols);
          const col = item.kind === "field" ? cols.find((c) => c.id === item.col) : undefined;
          const width = shown?.kind === "field" ? WIDTH_CLASS[shown.width] : "col-span-6";
          const isOver = over?.id === item.id && drag !== item.id;
          const horizontal = item.kind === "field" && (item.width === "half" || item.width === "third");
          return (
            <Fragment key={item.id}>
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", item.id);
                  setDrag(item.id);
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = horizontal ? e.clientX > box.left + box.width / 2 : e.clientY > box.top + box.height / 2;
                  if (over?.id !== item.id || over.after !== after) setOver({ id: item.id, after });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop();
                  setDrag(null);
                  setOver(null);
                }}
                onClick={() => setSelected(selected === item.id ? null : item.id)}
                className={clsx(
                  width,
                  "group relative cursor-pointer rounded-lg border p-3 transition",
                  selected === item.id ? "border-brand-400 bg-brand-50/40 ring-1 ring-brand-200" : "border-transparent hover:border-gray-200 hover:bg-gray-50/60",
                  drag === item.id && "opacity-40",
                  isOver && (horizontal ? (over.after ? "border-r-4 border-r-brand-500" : "border-l-4 border-l-brand-500") : over.after ? "border-b-4 border-b-brand-500" : "border-t-4 border-t-brand-500"),
                )}
              >
                <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <span className="pointer-events-auto cursor-grab rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700" title="Drag to move">
                    <GripVertical size={14} />
                  </span>
                  <button
                    className="pointer-events-auto rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    title="Remove from the form"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(item.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="pointer-events-none">
                  {shown ? (
                    <div className="grid grid-cols-6 gap-x-4">
                      <FormBlock item={shown.kind === "field" ? { ...shown, width: "full" } : shown} preview disabled />
                    </div>
                  ) : item.kind === "field" ? (
                    <p className="text-sm text-amber-700">{col ? `“${col.label || col.col_id}” is a formula column and can't be filled in.` : "This column was deleted."}</p>
                  ) : null}
                  {item.kind === "text" && !item.text && <p className="text-sm italic text-gray-400">Empty paragraph: click to write.</p>}
                </div>
              </div>
              {selected === item.id && (
                <div className="col-span-6 rounded-lg border border-brand-200 bg-white p-3 shadow-sm" onClick={(e) => e.stopPropagation()}>
                  <ItemEditor item={item} col={col} onChange={(p) => patch(item.id, p)} />
                </div>
              )}
            </Fragment>
          );
        })}
        {!items.length && <p className="col-span-6 rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">This form is empty. Add fields below.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-gray-200 pt-4">
        <Button size="sm" onClick={(e) => setAddMenu(e.currentTarget)} disabled={!unused.length} title={unused.length ? undefined : "Every column is on the form"}>
          <Plus size={13} /> Field
        </Button>
        <Button size="sm" variant="ghost" onClick={() => add([newFormItem("heading")])}>
          <Heading size={13} /> Heading
        </Button>
        <Button size="sm" variant="ghost" onClick={() => add([newFormItem("text")])}>
          <Pilcrow size={13} /> Text
        </Button>
        <Button size="sm" variant="ghost" onClick={() => add([newFormItem("separator")])}>
          <Minus size={13} /> Separator
        </Button>
        <span className="ml-auto text-xs text-gray-400">{selected ? "New blocks go after the selected one." : "Drag blocks to reorder."}</span>
      </div>
      <Popover anchor={addMenu} onClose={() => setAddMenu(null)}>
        {unused.length > 1 && (
          <>
            <MenuItem icon={<Plus size={13} />} onClick={() => add(unused.map((c) => newFormItem("field", c.id)))}>
              All {unused.length} remaining columns
            </MenuItem>
            <MenuDivider />
          </>
        )}
        <div className="scroll-thin max-h-72 overflow-y-auto">
          {unused.map((c) => (
            <MenuItem key={c.id} icon={<span className="text-[11px]">{COLUMN_TYPES.find((t) => t.type === c.type)?.icon}</span>} onClick={() => add([newFormItem("field", c.id)])}>
              {c.label || c.col_id}
            </MenuItem>
          ))}
        </div>
      </Popover>
      <Button variant="primary" disabled className="min-w-28">
        {form.submitLabel}
      </Button>
    </div>
  );
}

function ItemEditor({ item, col, onChange }: { item: FormItem; col?: DocColumn; onChange: (p: Partial<FormItem>) => void }) {
  if (item.kind === "separator") return <p className="text-xs text-gray-500">A line between parts of the form.</p>;
  if (item.kind === "heading") {
    return (
      <Labeled label="Heading">
        <TextCommit value={item.text} onCommit={(text) => onChange({ text })} autoFocus />
      </Labeled>
    );
  }
  if (item.kind === "text") {
    return (
      <Labeled label="Text (Markdown: **bold**, *italic*, [link](https://…), lists)">
        <TextCommit value={item.text} onCommit={(text) => onChange({ text })} multiline autoFocus />
      </Labeled>
    );
  }
  if (!col) return null;
  const displays = displayChoices(col.type);
  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <Labeled label={`Label (column: ${col.label || col.col_id}, ${COLUMN_TYPES.find((t) => t.type === col.type)?.label ?? col.type})`}>
        <TextCommit value={item.label ?? ""} placeholder={col.label || col.col_id} onCommit={(label) => onChange({ label })} autoFocus />
      </Labeled>
      <Labeled label="Help text">
        <TextCommit value={item.help ?? ""} onCommit={(help) => onChange({ help })} />
      </Labeled>
      <Labeled label="Width">
        <div className="flex rounded-md border border-gray-200 p-0.5 text-xs">
          {(["full", "half", "third"] as const).map((w) => (
            <button
              key={w}
              onClick={() => onChange({ width: w })}
              className={clsx("flex-1 rounded px-2 py-1", (item.width ?? "full") === w ? "bg-gray-100 font-medium" : "text-gray-500 hover:text-gray-800")}
            >
              {w === "full" ? "Full" : w === "half" ? "Half" : "Third"}
            </button>
          ))}
        </div>
      </Labeled>
      <div className="flex items-end gap-3">
        {displays.length > 0 && (
          <Labeled label="Show as" className="flex-1">
            <Select value={item.display ?? displays[0].value} onChange={(e) => onChange({ display: e.target.value as FormFieldDisplay })}>
              {displays.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Labeled>
        )}
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={!!item.required} onChange={(e) => onChange({ required: e.target.checked })} /> Required
        </label>
      </div>
      {(col.type === "Ref" || col.type === "RefList") && (
        <p className="col-span-2 text-xs text-amber-700">
          Everyone with the form link can see the {tableName(col.options.refTable)} records offered here
          {useDoc.getState().acl?.ruled ? " (only those a signed-out viewer may read under the access rules)" : ""}.
        </p>
      )}
      {col.type === "Attachments" && <p className="col-span-2 text-xs text-gray-500">Up to 10 files of 10 MB each.</p>}
    </div>
  );
}

const tableName = (ref?: string) => (ref ? (useDoc.getState().tables.get(ref)?.table_id ?? "linked") : "linked");

function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1 truncate text-xs text-gray-500" title={label}>
        {label}
      </div>
      {children}
    </div>
  );
}

/** A text box that saves when it loses focus (or on Enter, for one line). */
function TextCommit({
  value,
  onCommit,
  multiline,
  placeholder,
  autoFocus,
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const cls = "w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
  const commit = (v: string) => v !== value && onCommit(v);
  return multiline ? (
    <textarea key={value} defaultValue={value} rows={4} className={cls} autoFocus={autoFocus} onBlur={(e) => commit(e.target.value)} />
  ) : (
    <input
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      className={cls}
      autoFocus={autoFocus}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
