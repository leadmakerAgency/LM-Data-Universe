export type Role = "owner" | "editor" | "viewer";

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
  | "RefList";

export const COLUMN_TYPES: { type: ColumnType; label: string; icon: string }[] = [
  { type: "Any", label: "Any", icon: "∗" },
  { type: "Text", label: "Text", icon: "T" },
  { type: "Numeric", label: "Numeric", icon: "#" },
  { type: "Int", label: "Integer", icon: "1" },
  { type: "Bool", label: "Toggle", icon: "✓" },
  { type: "Date", label: "Date", icon: "◷" },
  { type: "DateTime", label: "DateTime", icon: "◴" },
  { type: "Choice", label: "Choice", icon: "◉" },
  { type: "ChoiceList", label: "Choice List", icon: "☰" },
  { type: "Ref", label: "Reference", icon: "→" },
  { type: "RefList", label: "Reference List", icon: "⇉" },
];

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  is_personal: boolean;
  created_at: string;
}

export interface DocumentRec {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

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
  created_at?: string;
  updated_at?: string;
}

export interface DocPage {
  id: string;
  doc_id: string;
  name: string;
  position: number;
}

export type WidgetType = "table" | "card" | "card_list" | "chart" | "summary" | "form";

export const WIDGET_TYPES: { type: WidgetType; label: string; description: string }[] = [
  { type: "table", label: "Table", description: "Spreadsheet-style grid of records" },
  { type: "card", label: "Card", description: "One record at a time, as a form-like card" },
  { type: "card_list", label: "Card List", description: "Scrollable list of record cards" },
  { type: "chart", label: "Chart", description: "Bar, line, area or pie chart" },
  { type: "summary", label: "Summary", description: "Group records and total them" },
  { type: "form", label: "Form", description: "Collect new records with a shareable form" },
];

export interface SortSpec {
  col: string;
  dir: "asc" | "desc";
}

export interface ColumnFilter {
  /** Values (as display strings) hidden from the view. */
  exclude?: string[];
  /** Inclusive numeric/date range. */
  min?: number | string | null;
  max?: number | string | null;
}

export interface FormField {
  col: string;
  required?: boolean;
  help?: string;
}

export interface WidgetOptions {
  sort?: SortSpec[];
  filters?: Record<string, ColumnFilter>;
  hidden?: string[];
  colWidths?: Record<string, number>;
  /** chart */
  chartType?: "bar" | "line" | "area" | "pie";
  xCol?: string | null;
  yCols?: string[];
  aggregate?: "none" | "sum" | "count" | "avg";
  stacked?: boolean;
  /** summary */
  groupBy?: string[];
  /** form */
  fields?: FormField[];
  formTitle?: string;
  formDescription?: string;
  submitLabel?: string;
  successMessage?: string;
}

export interface DocWidget {
  id: string;
  doc_id: string;
  page_id: string;
  table_ref: string | null;
  type: WidgetType;
  title: string;
  position: number;
  width: number;
  height: number;
  options: WidgetOptions;
  link_source: string | null;
  link_col: string | null;
}

export interface FormShare {
  id: string;
  token: string;
  doc_id: string;
  widget_id: string;
  is_active: boolean;
}

export interface Member {
  user_id: string;
  role: Role;
  profile?: Profile;
}
