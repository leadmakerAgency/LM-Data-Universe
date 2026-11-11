// Data model the formula engine works on. Framework-free: shared by the web
// app (src/lib/types.ts re-exports these) and the server-side formula worker.
export type ColumnType =
  | "Any"
  | "Text"
  | "Numeric"
  | "Int"
  | "Bool"
  | "Date"
  | "DateTime"
  | "Choice"
  | "ChoiceList"
  | "Ref"
  | "RefList"
  | "Attachments";

export interface ColumnOptions {
  /** Numeric */
  decimals?: number | null;
  numMode?: "decimal" | "currency" | "percent";
  currency?: string;
  /** Date / DateTime */
  dateFormat?: string;
  /** Choice / ChoiceList */
  choices?: string[];
  choiceColors?: Record<string, string>;
  /** Ref / RefList: target table uuid and the column displayed for it */
  refTable?: string;
  visibleCol?: string | null;
  /** Text */
  wrap?: boolean;
  alignment?: "left" | "center" | "right";
  /** Text shown as Markdown, or as a link (text or "label url") */
  textFormat?: "plain" | "markdown" | "hyperlink";

  /** Cell style of the whole column, and of its header. */
  style?: CellStyle;
  headerStyle?: CellStyle;
  /** Conditional styles, applied in order (later rules win where they overlap). */
  rules?: StyleRule[];

  /** Trigger formula: a data column whose `formula` runs on new records and/or on changes. */
  trigger?: { onNew?: boolean; onChange?: "any" | string[] };

  /** Ref / RefList: the column in the target table kept in sync as the other side of a two-way reference. */
  reverseCol?: string | null;
  /** Set on the column created as the other side of a two-way reference. */
  reverseSecondary?: boolean;
  /** Ref / RefList / Choice: formula over `choice` (and `$Col` of this record) limiting the dropdown. */
  dropdownCondition?: string;
}

export interface CellStyle {
  textColor?: string;
  fillColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** A conditional style: when `formula` is true for the record, `style` applies. */
export interface StyleRule {
  id: string;
  formula: string;
  style: CellStyle;
}

export interface DocTable {
  id: string;
  doc_id: string;
  table_id: string;
  position: number;
}

export interface DocColumn {
  id: string;
  doc_id: string;
  table_ref: string;
  col_id: string;
  label: string;
  type: ColumnType;
  is_formula: boolean;
  formula: string;
  options: ColumnOptions;
  position: number;
}

export type CellValue = string | number | boolean | null | (string | number)[];

export interface DocRow {
  id: number;
  table_ref: string;
  manual_sort: number;
  data: Record<string, CellValue>;
  /** Formula values computed on the server (used where the browser can't see every record). */
  computed?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}
