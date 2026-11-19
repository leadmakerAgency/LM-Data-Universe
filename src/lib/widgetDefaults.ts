// What a new Board, Timeline or Gallery starts with, picked from the table's columns.
import type { WidgetOptions, WidgetType } from "./types";

type Col = { id: string; type: string; is_formula?: boolean; options?: { refTable?: string } };

export function viewDefaults(type: WidgetType, cols: Col[], tableRef?: string | null): WidgetOptions {
  const data = cols.filter((c) => !c.is_formula);
  const attachments = cols.find((c) => c.type === "Attachments")?.id ?? null;
  const title = cols.find((c) => c.type === "Text")?.id ?? cols[0]?.id ?? null;
  if (type === "board") {
    const stack = data.find((c) => c.type === "Choice") ?? data.find((c) => c.type === "Ref") ?? data.find((c) => c.type === "Bool");
    const sum = cols.find((c) => c.type === "Numeric" || c.type === "Int")?.id ?? null;
    return { boardCol: stack?.id ?? null, boardSum: sum, tileTitle: title, tileCover: attachments };
  }
  if (type === "gallery") return { tileTitle: title, tileCover: attachments, galSize: "medium", galMode: "records" };
  if (type === "timeline") {
    const dates = cols.filter((c) => c.type === "Date" || c.type === "DateTime");
    const deps = data.find((c) => c.type === "RefList" && !!tableRef && c.options?.refTable === tableRef)?.id ?? null;
    return { tlStart: dates[0]?.id ?? null, tlEnd: dates[1]?.id ?? null, tlDeps: deps, tlZoom: "week", tileTitle: title };
  }
  return {};
}
