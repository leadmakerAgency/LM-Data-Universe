// Tags ("placeholders") in automation emails: {{ColId}}, {{Column label}},
// {{Reference.Column}}, a few document tags, each with an optional fallback
// ({{Name|there}}). The database fills them (see *_mail.sql); this is the same
// reading of the syntax for the editor: listing, checking and inserting.
import type { DocColumn } from "./types";

export interface MailTag {
  /** What goes between the braces. */
  name: string;
  /** Shown in the picker. */
  label: string;
  hint?: string;
}

/** Tags that aren't columns. */
export const DOCUMENT_TAGS: MailTag[] = [
  { name: "record_link", label: "Link to the record", hint: "Opens this record in the app" },
  { name: "link", label: "Link to the document" },
  { name: "id", label: "Record number" },
  { name: "changed_by", label: "Who made the change" },
  { name: "doc", label: "Document name" },
  { name: "table", label: "Table name" },
  { name: "automation", label: "Automation name" },
];
const DOCUMENT_TAG_NAMES = new Set(DOCUMENT_TAGS.map((t) => t.name));

const TAG = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/** Every tag in a text, in order. */
export function tagsIn(text: string): { name: string; fallback: string | null }[] {
  return [...(text ?? "").matchAll(TAG)].map((m) => ({ name: m[1], fallback: m[2] ?? null }));
}

/** Tags a table offers: its columns, then fields of the records its Reference columns point at. */
export function columnTags(cols: DocColumn[], columnsOf: (tableRef: string) => DocColumn[]): { columns: MailTag[]; references: MailTag[] } {
  const columns = cols.map((c) => ({ name: c.col_id, label: c.label || c.col_id }));
  const references: MailTag[] = [];
  for (const c of cols) {
    if (c.type !== "Ref" || !c.options.refTable) continue;
    for (const f of columnsOf(c.options.refTable)) {
      references.push({ name: `${c.col_id}.${f.col_id}`, label: `${c.label || c.col_id} → ${f.label || f.col_id}` });
    }
  }
  return { columns, references };
}

/** The first tag that means nothing for this table, or null. Mirrors `_template_problem` in the database. */
export function unknownTag(text: string, cols: DocColumn[], columnsOf: (tableRef: string) => DocColumn[]): string | null {
  for (const { name } of tagsIn(text)) {
    const lower = name.toLowerCase();
    if (DOCUMENT_TAG_NAMES.has(lower)) continue;
    const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(name);
    if (dotted) {
      const ref = cols.find((c) => c.col_id === dotted[1] && c.type === "Ref" && c.options.refTable);
      if (ref && (dotted[2] === "id" || columnsOf(ref.options.refTable!).some((f) => f.col_id === dotted[2]))) continue;
      return name;
    }
    if (cols.some((c) => c.col_id === name || (c.label || "").toLowerCase() === lower)) continue;
    return name;
  }
  return null;
}

/** Puts a tag into a text at a cursor position (or over a selection); returns the text and the new cursor. */
export function insertTag(text: string, tag: string, start: number | null, end: number | null): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start ?? text.length, text.length));
  const e = Math.max(s, Math.min(end ?? s, text.length));
  const piece = `{{${tag}}}`;
  return { text: text.slice(0, s) + piece + text.slice(e), cursor: s + piece.length };
}
