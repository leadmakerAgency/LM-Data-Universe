// Card layouts: which fields a card shows, in what order and how wide.
import type { CardLayout, DocColumn, DocWidget } from "./types";
import { tableColumns, useDoc } from "@/store/docStore";

export interface CardField {
  col: DocColumn;
  span: 1 | 2 | 3;
}

/** Fields of a card: the layout's order first, then any columns it doesn't mention (unless hidden). */
export function cardFields(tableRef: string | null, layout: CardLayout | undefined, hidden: string[] = []): CardField[] {
  const cols = tableColumns(tableRef);
  const byId = new Map(cols.map((c) => [c.id, c]));
  const hide = new Set(hidden);
  const out: CardField[] = [];
  const seen = new Set<string>();
  for (const f of layout?.fields ?? []) {
    const c = byId.get(f.col);
    if (!c || hide.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ col: c, span: f.span ?? 1 });
  }
  for (const c of cols) if (!seen.has(c.id) && !hide.has(c.id)) out.push({ col: c, span: 1 });
  return out;
}

/** The layout record cards of a table use: the first card widget's, if any. */
export function tableCardLayout(tableRef: string): { layout?: CardLayout; hidden: string[] } {
  const w = [...useDoc.getState().widgets.values()]
    .filter((x: DocWidget) => x.table_ref === tableRef && (x.type === "card" || x.type === "card_list"))
    .sort((a, b) => a.position - b.position)[0];
  return { layout: w?.options.cardLayout, hidden: w?.options.hidden ?? [] };
}

export const CARD_THEMES: { id: NonNullable<CardLayout["theme"]>; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "compact", label: "Compact" },
  { id: "bordered", label: "Bordered" },
];
