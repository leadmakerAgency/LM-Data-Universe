// Forms: the layout stored on a form widget, and the definition a form page
// renders. The public page gets its definition from `get_public_form`; the
// builder makes the same shape from local data so the preview matches.
import type { CellValue, ColumnOptions, ColumnType, DocColumn, DocWidget, FormFieldDisplay, FormItem } from "./types";

export const MAX_FORM_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface PublicFormField {
  kind: "field";
  id: string;
  label: string;
  type: ColumnType;
  options: ColumnOptions;
  required: boolean;
  help: string;
  width: "full" | "half" | "third";
  display: FormFieldDisplay | "";
  /** Ref / RefList: the records to pick from. */
  choices?: { id: number; label: string }[];
}

export type PublicFormItem = PublicFormField | { kind: "heading"; text: string } | { kind: "text"; text: string } | { kind: "separator" };

export interface PublicForm {
  title: string;
  description: string;
  submitLabel: string;
  successMessage: string;
  redirectUrl?: string;
  submitAnother?: boolean;
  maxUploadBytes?: number;
  items?: PublicFormItem[];
  /** Older servers: plain fields only. */
  fields?: Omit<PublicFormField, "kind" | "width" | "display">[];
}

/** Columns a form can fill in. */
export const formColumn = (c: { is_formula?: boolean }) => !c.is_formula;

const itemId = () => Math.random().toString(36).slice(2, 10);

/** The form's layout: `formItems`, or one made from the older `fields` list. */
export function formItemsOf(widget: Pick<DocWidget, "options">): FormItem[] {
  const o = widget.options;
  if (Array.isArray(o.formItems)) return o.formItems;
  return (o.fields ?? []).map((f, i) => ({ id: `f${i}-${f.col.slice(0, 8)}`, kind: "field", col: f.col, required: f.required, help: f.help }));
}

export function newFormItem(kind: FormItem["kind"], col?: string): FormItem {
  const id = itemId();
  switch (kind) {
    case "field":
      return { id, kind, col: col ?? "" };
    case "heading":
      return { id, kind, text: "New section" };
    case "text":
      return { id, kind, text: "" };
    case "separator":
      return { id, kind };
  }
}

/** A starting layout: every column a form can fill in. */
export function defaultFormItems(cols: { id: string; is_formula?: boolean }[]): FormItem[] {
  return cols.filter(formColumn).map((c) => newFormItem("field", c.id));
}

/** Items of a definition, also for servers that only send `fields`. */
export function publicItems(form: PublicForm): PublicFormItem[] {
  if (form.items) return form.items;
  return (form.fields ?? []).map((f) => ({ ...f, kind: "field" as const, width: "full" as const, display: "" as const }));
}

/** Display choices a column type allows (first is the default). */
export function displayChoices(type: ColumnType): { value: FormFieldDisplay; label: string }[] {
  switch (type) {
    case "Choice":
    case "Ref":
      return [
        { value: type === "Choice" ? "radio" : "dropdown", label: type === "Choice" ? "Buttons" : "Dropdown" },
        { value: type === "Choice" ? "dropdown" : "radio", label: type === "Choice" ? "Dropdown" : "Buttons" },
      ];
    case "Bool":
      return [
        { value: "checkboxes", label: "Checkbox" },
        { value: "switch", label: "Switch" },
      ];
    default:
      return [];
  }
}

/** The value a form input holds, turned into what the column stores. */
export type FormInputValue = string | boolean | string[] | number[];

export function toStored(type: ColumnType, v: FormInputValue): CellValue {
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length ? (v as (string | number)[]) : null;
  if (v.trim() === "") return null;
  switch (type) {
    case "Numeric":
    case "Int": {
      const n = Number(v);
      return isNaN(n) ? v : n;
    }
    case "Ref": {
      const n = Number(v);
      return Number.isInteger(n) ? n : v;
    }
    case "DateTime": {
      const d = new Date(v);
      return isNaN(d.getTime()) ? v : d.toISOString();
    }
    default:
      return v;
  }
}

/** Whether a value counts as filled in. */
export function isFilled(v: FormInputValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.length > 0;
  return v.trim() !== "";
}
