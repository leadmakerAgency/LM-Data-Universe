import type { ColumnType } from "@engine/types";

export type { CellStyle, CellValue, ColumnOptions, ColumnType, DocColumn, DocRow, DocTable, StyleRule } from "@engine/types";
import type { StyleRule } from "@engine/types";
import type { AclNode } from "@engine/acl";

export type Role = "owner" | "editor" | "viewer";

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
  { type: "Attachments", label: "Attachments", icon: "⎙" },
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
  team_id?: string | null;
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

export interface DocumentRec {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** In the trash since (soft-deleted); purged after 30 days. */
  deleted_at?: string | null;
  /** Set on a copy made with "Work on a copy": the document it can replace. */
  forked_from?: string | null;
  /** Document settings: locale, default currency and time zone. */
  settings?: DocSettings;
  /** "hub": the hidden document behind a workspace's sidebar sections. */
  kind?: "document" | "hub";
  /** The hub's sections (hubs only). */
  hub_config?: Record<string, unknown>;
  /** The client (a row of the workspace hub's Clients table) this document belongs to. */
  hub_client?: number | null;
}

export interface DocSettings {
  /** BCP 47 locale for numbers and month names ("en-US", "nl-NL"); the viewer's browser when unset. */
  locale?: string;
  /** ISO 4217 currency for currency columns that don't name one. */
  currency?: string;
  /** IANA time zone for DateTime values and TODAY(); the viewer's own when unset. */
  timezone?: string;
}

export interface DocPage {
  id: string;
  doc_id: string;
  name: string;
  position: number;
  /** Docked widget layout tree; empty object means widgets in position order. */
  layout?: Record<string, unknown>;
}

export type WidgetType = "table" | "card" | "card_list" | "chart" | "summary" | "form" | "calendar" | "custom" | "board" | "timeline" | "gallery";

export const WIDGET_TYPES: { type: WidgetType; label: string; description: string }[] = [
  { type: "table", label: "Table", description: "Spreadsheet-style grid of records" },
  { type: "card", label: "Card", description: "One record at a time, as a form-like card" },
  { type: "card_list", label: "Card List", description: "Scrollable list of record cards" },
  { type: "chart", label: "Chart", description: "Bar, line, area or pie chart" },
  { type: "summary", label: "Summary", description: "Group records and total them" },
  { type: "form", label: "Form", description: "Collect new records with a shareable form" },
  { type: "calendar", label: "Calendar", description: "Records with dates as events by month, week or day" },
  { type: "board", label: "Board", description: "Cards in stacks by stage, status or owner; drag to change" },
  { type: "timeline", label: "Timeline", description: "Records as bars across time, with dependencies" },
  { type: "gallery", label: "Gallery", description: "Tiles with a cover image or file, for assets and files" },
  { type: "custom", label: "Custom", description: "A map, invoice, labels, or any web page given the data" },
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

/** How a field is shown on a form, where its column type allows a choice. */
export type FormFieldDisplay = "radio" | "dropdown" | "checkboxes" | "switch";

/** One block of a form layout. `id` is only for the builder. */
export type FormItem =
  | {
      id: string;
      kind: "field";
      col: string;
      required?: boolean;
      help?: string;
      /** Shown instead of the column label. */
      label?: string;
      width?: "full" | "half" | "third";
      display?: FormFieldDisplay;
    }
  | { id: string; kind: "heading"; text: string }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "separator" };

export type CalendarView = "month" | "week" | "day";

/** What a custom widget may see and do. */
export type CustomAccess = "none" | "read" | "full";

export interface WidgetOptions {
  sort?: SortSpec[];
  filters?: Record<string, ColumnFilter>;
  hidden?: string[];
  colWidths?: Record<string, number>;
  /**
   * Linking through a reference column of the *source* widget's table that points at this
   * widget's table ("Orders → its Customer"): a Reference moves the cursor to that record,
   * a Reference List shows just those records. Used with link_source (link_col stays null).
   */
  linkSourceCol?: string | null;
  /** table: number of leftmost visible columns kept in view while scrolling */
  frozen?: number;
  /** table: conditional styles applied to whole rows */
  rowRules?: StyleRule[];
  /** card / card list (and record cards of the table): field order, widths and look */
  cardLayout?: CardLayout;
  /** chart */
  chartType?: "bar" | "line" | "area" | "pie" | "scatter";
  xCol?: string | null;
  yCols?: string[];
  aggregate?: "none" | "sum" | "count" | "avg";
  stacked?: boolean;
  /** chart: one series per value of this column */
  splitBy?: string | null;
  /** chart: error bar size per series column (column id -> column id) */
  errorCols?: Record<string, string>;
  invertY?: boolean;
  /** line / area: draw across missing values */
  connectGaps?: boolean;
  /** line / area / scatter: show a dot at each point */
  markers?: boolean;
  /** summary */
  groupBy?: string[];
  /** summary: date group-by columns bucketed by period */
  groupDates?: Record<string, DateBucket>;
  /** summary: extra columns computed per group from `$group` (the group's records) */
  summaryFormulas?: { id: string; label: string; formula: string }[];
  /** form: the layout (newer forms); `fields` is the older plain list */
  formItems?: FormItem[];
  fields?: FormField[];
  /** form: where to send people after submitting (http/https only) */
  redirectUrl?: string;
  /** form: offer "Submit another response" (default true) */
  submitAnother?: boolean;
  formTitle?: string;
  formDescription?: string;
  submitLabel?: string;
  successMessage?: string;
  /**
   * Only records that point at this record through this column (a Reference or
   * Reference List): the client filter of hub sections. Not saved with a view.
   */
  onlyRef?: { col: string; id: number } | null;
  /** A saved view's name (hub sections). */
  viewName?: string;
  /** board / gallery / timeline: how a record's tile looks */
  tileTitle?: string | null;
  /** Columns shown on the tile, in order (default: the first few). */
  tileFields?: string[];
  /** An Attachments column whose first file is the cover. */
  tileCover?: string | null;
  tileCoverFit?: "crop" | "fit";
  /** Show each field's name above its value. */
  tileLabels?: boolean;
  /** A Choice column whose colour marks the tile. */
  tileColor?: string | null;

  /** board: the column whose values are the stacks (Choice, Reference or Toggle) */
  boardCol?: string | null;
  /** board: a second grouping across the board, one lane per value */
  boardLane?: string | null;
  /** board: a number column totalled in each stack's header */
  boardSum?: string | null;
  /** board: most cards a stack should hold (stack key -> limit) */
  boardWip?: Record<string, number>;
  /** board: stacks not shown (stack keys; "" is the stack of records without a value) */
  boardHidden?: string[];
  boardHideEmpty?: boolean;
  /** board: a condition a record must meet before it may enter a stack (stack key -> formula) */
  boardRules?: Record<string, string>;
  /** board: show how long each card has been in its stack (a DateTime column stamped when the stack changes) */
  boardSince?: string | null;

  /** gallery */
  galSize?: "small" | "medium" | "large";
  galGroup?: string | null;
  /** One tile per record, or one per file of the cover column. */
  galMode?: "records" | "files";

  /** timeline */
  tlStart?: string | null;
  tlEnd?: string | null;
  tlGroup?: string | null;
  /** A Reference List column to the same table: the records this one waits for. */
  tlDeps?: string | null;
  /** A number column (0 to 1, or 0 to 100) drawn as progress inside the bar. */
  tlProgress?: string | null;
  tlZoom?: TimelineZoom;

  /** calendar */
  calStart?: string | null;
  calEnd?: string | null;
  calTitle?: string | null;
  calColor?: string | null;
  calView?: CalendarView;
  /** custom: a built-in widget ("map", "invoice", ...) or a URL */
  builtin?: string | null;
  customUrl?: string;
  customAccess?: CustomAccess;
  /** custom: the widget's named inputs mapped to column ids */
  customMapping?: Record<string, string | string[] | null>;
  /** custom: settings the widget saved for itself */
  customOptions?: Record<string, unknown>;
}

export type TimelineZoom = "day" | "week" | "month" | "quarter" | "year";

export type DateBucket = "day" | "week" | "month" | "quarter" | "year";

export interface CardLayout {
  fields: { col: string; span?: 1 | 2 | 3 }[];
  theme?: "default" | "compact" | "bordered";
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

// ---- Access rules (Phase 3)

export type AclPermission = "read" | "create" | "update" | "delete";

export interface AccessSettings {
  /** Editors may add, change and remove tables and columns (owners always can). */
  editors_structure: boolean;
  /** Only owners may copy the document or download its data. */
  block_copies: boolean;
  /** Everyone with access may read the rules. */
  public_rules: boolean;
}

/**
 * What the current person (or the person viewed as) may do, from `acl_info`.
 * true / false, or null when it depends on the record.
 */
export interface AclInfo {
  ruled: boolean;
  access: Role | null;
  email: string;
  view_as: string | null;
  structure: boolean;
  settings: AccessSettings;
  tables: Record<string, Record<AclPermission, boolean | null>>;
  cols: Record<string, { read: boolean | null; update: boolean | null }>;
  hidden_cols: string[];
}

export interface AccessRule {
  id?: string;
  /** null: a default rule for every table. */
  table_ref: string | null;
  /** Empty: the rule is about whole records. */
  col_ids: string[];
  condition: string;
  condition_ast: AclNode | null;
  permissions: Partial<Record<AclPermission, boolean>>;
  memo?: string | null;
  /** From the server: false when the condition no longer compiles (it then fails closed). */
  valid?: boolean;
}

export interface UserAttribute {
  id?: string;
  name: string;
  user_field: "Email" | "UserID" | "Name";
  table_ref: string;
  match_col: string;
}
