// Board (Kanban) logic without React: which stacks a column gives, which stack
// a record is in, and what to store when a card is dropped on a stack.
import { RecordRef } from "@engine/values";
import type { CellValue, DocColumn } from "./types";

export interface Stack {
  /** "" is the stack of records without a value. */
  key: string;
  label: string;
  color?: string;
}

/** Columns a board can stack (or lane) by. */
export const stackable = (c: Pick<DocColumn, "type">) => c.type === "Choice" || c.type === "Ref" || c.type === "Bool";

/** The stack a runtime value belongs to. */
export function stackKey(col: Pick<DocColumn, "type">, v: unknown): string {
  if (col.type === "Bool") return v === true ? "true" : "false";
  if (v instanceof RecordRef) return v.rowId ? `#${v.rowId}` : "";
  if (typeof v === "number" && col.type === "Ref") return v ? `#${v}` : "";
  if (v === null || v === undefined || v === "") return "";
  return typeof v === "string" ? v : String(v);
}

/** What a cell holds when its record sits in this stack. */
export function stackValue(col: Pick<DocColumn, "type">, key: string): CellValue {
  if (col.type === "Bool") return key === "true";
  if (key === "") return null;
  if (col.type === "Ref") return Number(key.slice(1)) || null;
  return key;
}

/**
 * The stacks of a column, in order: "no value" first (when records have none,
 * or always for references), then the choices / referenced records / No, Yes.
 * `present` are the keys records actually have: values that are no longer a
 * choice still get a stack so no record disappears.
 */
export function stacksFor(
  col: Pick<DocColumn, "type" | "options">,
  refs: { id: number; label: string }[],
  present: Set<string>,
  colorOf: (choice: string) => string | undefined = () => undefined,
): Stack[] {
  if (col.type === "Bool") return [{ key: "false", label: "No" }, { key: "true", label: "Yes" }];
  const out: Stack[] = [];
  const seen = new Set<string>();
  const add = (s: Stack) => {
    if (seen.has(s.key)) return;
    seen.add(s.key);
    out.push(s);
  };
  if (present.has("")) add({ key: "", label: col.type === "Ref" ? "Nobody / nothing" : "No value" });
  if (col.type === "Choice") {
    for (const c of col.options.choices ?? []) add({ key: c, label: c, color: colorOf(c) });
    for (const k of present) if (k !== "") add({ key: k, label: k, color: colorOf(k) });
  } else {
    for (const r of refs) add({ key: `#${r.id}`, label: r.label || `#${r.id}` });
    for (const k of present) if (k !== "") add({ key: k, label: k });
  }
  return out;
}

/** Records by lane and stack, keeping the given order. A single lane has the key "*". */
export function groupCards(ids: number[], stackOf: (id: number) => string, laneOf: ((id: number) => string) | null): Map<string, Map<string, number[]>> {
  const out = new Map<string, Map<string, number[]>>();
  for (const id of ids) {
    const lane = laneOf ? laneOf(id) : "*";
    const stacks = out.get(lane) ?? new Map<string, number[]>();
    const list = stacks.get(stackOf(id)) ?? [];
    list.push(id);
    stacks.set(stackOf(id), list);
    out.set(lane, stacks);
  }
  return out;
}

/** "3 d", "5 h", "12 min": how long ago a moment was, for "time in this stack". */
export function ago(since: Date, now = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}
