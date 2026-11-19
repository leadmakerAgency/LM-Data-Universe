// State of the open document: schema, rows, pages and widgets, kept in sync
// with Supabase. Every change is a bundle of actions (see lib/actions.ts) sent
// to the `apply_actions` RPC, which is the only write path the database allows.
// Edits are applied locally first where possible; writes go out one at a time,
// in order. Undo/redo run on the server from the action log, so they survive
// reloads. Realtime events from collaborators are merged in as they arrive.
import { defaultFormItems } from "@/lib/forms";
import { viewDefaults } from "@/lib/widgetDefaults";
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, fetchAll, errorMessage } from "@/lib/supabase";
import { Engine, type FormulaUser } from "@engine/engine";
import { applyTriggers } from "@engine/triggers";
import { initialReverse, reverseRepair, reverseSync } from "@/lib/reverse";
import { renameTableInFormula } from "@engine/parser";
import { DependencyAnalyzer } from "@engine/deps";
import { renameColumnRefs } from "@engine/rename";
import { FormulaError } from "@engine/values";
import { convertValue, displayValue, parseInput, setFormatSettings, type DisplayContext, type ParseContext } from "@/lib/format";
import { isValidTimeZone } from "@engine/zone";
import { between, labelToIdent, nextColumnLetter, uniqueIdent } from "@/lib/ids";
import { applyActionsLocal, cellUpdates, newId, type ApplyResult, type DocAction } from "@/lib/actions";
import { toast } from "./toasts";
import type {
  AclInfo,
  CellValue,
  ColumnType,
  DocColumn,
  DocPage,
  DocRow,
  DocTable,
  DocSettings,
  DocWidget,
  DocumentRec,
  FormShare,
  Role,
  WidgetOptions,
  WidgetType,
} from "@/lib/types";

const ROW_FIELDS = "id,table_ref,manual_sort,data";

export interface CellChange {
  tableRef: string;
  rowId: number;
  colId: string;
  value: CellValue;
}

export interface NewWidgetSpec {
  type: WidgetType;
  tableRef: string | "new";
  title?: string;
  linkSource?: string | null;
  linkCol?: string | null;
  /** Link through a reference column of the source widget's table (see WidgetOptions.linkSourceCol). */
  linkSourceCol?: string | null;
  width?: number;
}

export type SaveState = "saved" | "saving" | "error";

interface DocState {
  docId: string | null;
  doc: DocumentRec | null;
  role: Role | null;
  loading: boolean;
  error: string | null;
  tables: Map<string, DocTable>;
  columns: Map<string, DocColumn>;
  rows: Map<string, Map<number, DocRow>>;
  pages: DocPage[];
  widgets: Map<string, DocWidget>;
  formShares: Map<string, FormShare>;
  version: number;
  cursors: Record<string, number | null>;
  canUndo: boolean;
  canRedo: boolean;
  /** Writes waiting for or in flight to the server. */
  pendingWrites: number;
  saveState: SaveState;
  /** The signed-in person, as the `user` object of formulas. */
  me: FormulaUser | null;
  /** Set while viewing a snapshot: the document is shown read-only. */
  snapshot: { id: number; kind: string; label: string | null; created_at: string; realRole: Role | null } | null;
  /** What access rules allow (null until loaded, or when the server has no rules support). */
  acl: AclInfo | null;
  /** Owners only: the email of the person whose view is shown (read-only). */
  viewAs: string | null;

  load(docId: string): Promise<void>;
  /** Shows the document as another person sees it (owners), or null to stop. */
  setViewAs(email: string | null): Promise<void>;
  /** Shows a snapshot of the document, read-only, in place of its current content. */
  loadSnapshot(docId: string, snapshotId: number): Promise<void>;
  unload(): void;
  canEdit(): boolean;

  setCells(changes: CellChange[], opts?: { undoable?: boolean }): Promise<void>;
  addRows(tableRef: string, rows: { data: Record<string, CellValue>; manual_sort?: number }[], opts?: { undoable?: boolean }): Promise<DocRow[]>;
  deleteRows(tableRef: string, ids: number[], opts?: { undoable?: boolean }): Promise<void>;
  /** Moves rows (in their current relative order) before another row, or to the end. */
  moveRows(tableRef: string, ids: number[], beforeId: number | null, values?: Record<string, CellValue>): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;

  addTable(name?: string, columns?: { label: string; type?: ColumnType }[]): Promise<DocTable | null>;
  renameTable(tableRef: string, name: string): Promise<boolean>;
  deleteTable(tableRef: string): Promise<void>;

  addColumn(tableRef: string, init?: Partial<DocColumn>, position?: number): Promise<DocColumn | null>;
  updateColumn(colId: string, patch: Partial<DocColumn>, opts?: { undoable?: boolean }): Promise<boolean>;
  deleteColumn(colId: string): Promise<void>;
  addTwoWay(colId: string): Promise<void>;
  removeTwoWay(colId: string): Promise<void>;

  renameDoc(name: string): Promise<void>;
  /** Saves Document settings (locale, currency, time zone); owners and editors. */
  saveSettings(settings: DocSettings): Promise<boolean>;
  addPage(name: string, widget: NewWidgetSpec): Promise<DocPage | null>;
  renamePage(pageId: string, name: string): Promise<void>;
  movePage(pageId: string, delta: number): Promise<void>;
  deletePage(pageId: string): Promise<void>;
  addWidget(pageId: string, spec: NewWidgetSpec): Promise<DocWidget | null>;
  updateWidget(id: string, patch: Partial<DocWidget>): Promise<void>;
  deleteWidget(id: string): Promise<void>;
  /** Puts a page's widgets in this order (one save). */
  reorderWidgets(ids: string[]): Promise<void>;
  duplicateWidget(id: string): Promise<DocWidget | null>;
  setCursor(widgetId: string, rowId: number | null): void;

  setFormShare(widgetId: string, active: boolean): Promise<FormShare | null>;
}

let channel: RealtimeChannel | null = null;
// Private Broadcast channel carrying change notices (row ids only) for documents with access rules.
let notices: RealtimeChannel | null = null;
let noticeSeq = 0;
// Each load gets a token; results of an older, superseded load are dropped.
let loadToken = 0;
let channelSeq = 0;

function dropChannel() {
  if (channel) {
    // removeChannel (not just unsubscribe) so the client forgets the topic;
    // otherwise reopening the document reuses an already-subscribed channel.
    void supabase().removeChannel(channel);
    channel = null;
  }
  noticeSeq++;
  if (notices) {
    void supabase().removeChannel(notices);
    notices = null;
  }
}

const READ_PAGE = 1000; // the API's default row cap

/**
 * Records through `read_rows`, which applies access rules: every record the
 * person may read (keyset-paged), or just the given ids.
 */
async function readRows(docId: string, viewAs: string | null, ids?: number[]): Promise<DocRow[]> {
  const sb = supabase();
  const out: DocRow[] = [];
  if (ids) {
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await sb.rpc("read_rows", { p_doc: docId, p_ids: ids.slice(i, i + 500), p_limit: READ_PAGE, p_as: viewAs });
      if (error) throw error;
      out.push(...(data as DocRow[]));
    }
    return out;
  }
  let after = 0;
  for (;;) {
    const { data, error } = await sb.rpc("read_rows", { p_doc: docId, p_after: after, p_limit: READ_PAGE, p_as: viewAs });
    if (error) throw error;
    const page = data as DocRow[];
    if (!page.length) return out;
    out.push(...page);
    after = page[page.length - 1].id;
  }
}

/** True when the database doesn't have the access-rules functions yet (older deployment). */
function missingFunction(e: { code?: string; message?: string } | null) {
  return !!e && (e.code === "PGRST202" || /could not find the function/i.test(e.message ?? ""));
}
// Rows with writes in flight: realtime echoes for them are ignored until the
// write returns the canonical row.
const pendingRows = new Map<number, number>();

function sortedPages(pages: DocPage[]) {
  return [...pages].sort((a, b) => a.position - b.position);
}

// ---- derived data, recomputed once per version
let derivedVersion = -1;
let derivedDoc: string | null = null;
let derived: {
  colsByTable: Map<string, DocColumn[]>;
  engine: Engine;
  refIndex: Map<string, Map<string, number>>;
} | null = null;

export function getDerived() {
  const s = useDoc.getState();
  if (!derived || derivedVersion !== s.version || derivedDoc !== s.docId) {
    const colsByTable = new Map<string, DocColumn[]>();
    for (const t of s.tables.values()) colsByTable.set(t.id, []);
    for (const c of s.columns.values()) {
      const list = colsByTable.get(c.table_ref);
      if (list) list.push(c);
    }
    for (const list of colsByTable.values()) list.sort((a, b) => a.position - b.position);
    // With access rules the browser only has some records: show the server's formula values.
    // Document settings: formatting reads them globally; TODAY() uses the time zone.
    setFormatSettings(s.doc?.settings);
    const timezone = s.doc?.settings?.timezone || null;
    const engine = new Engine(
      { tables: s.tables, columns: s.columns, colsByTable, rows: s.rows },
      { user: s.me, serverValues: !!s.acl?.ruled, timezone: timezone && isValidTimeZone(timezone) ? timezone : null },
    );
    derived = { colsByTable, engine, refIndex: new Map() };
    derivedVersion = s.version;
    derivedDoc = s.docId;
  }
  return derived;
}

export function displayCtx(): DisplayContext & ParseContext {
  const d = getDerived();
  return {
    engine: d.engine,
    colsByTable: d.colsByTable,
    resolveRef(col, text) {
      const target = col.options.refTable;
      if (!target) return null;
      const cols = d.colsByTable.get(target) ?? [];
      const display = cols.find((c) => c.id === col.options.visibleCol) ?? cols[0];
      if (!display) return null;
      const key = `${target}|${display.id}`;
      let index = d.refIndex.get(key);
      if (!index) {
        index = new Map();
        for (const id of d.engine.rowIds(target)) {
          const v = d.engine.safeValue(display, id);
          if (v instanceof FormulaError) continue;
          const shown = displayValue(this, display, v).trim().toLowerCase();
          if (shown && !index.has(shown)) index.set(shown, id);
        }
        d.refIndex.set(key, index);
      }
      return index.get(text.trim().toLowerCase()) ?? null;
    },
  };
}

export function tableColumns(tableRef: string | null | undefined): DocColumn[] {
  if (!tableRef) return [];
  return getDerived().colsByTable.get(tableRef) ?? [];
}

// Writes run one after another so the server sees them in the order they were made.
let writeChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeChain.then(fn, fn);
  writeChain = p.catch(() => undefined);
  return p;
}

/** Fields of a column that are stored (and can be patched). */
function columnPatch(c: DocColumn): Record<string, unknown> {
  return { col_id: c.col_id, label: c.label, type: c.type, is_formula: c.is_formula, formula: c.formula, options: c.options, position: c.position };
}

function rowsEqual(a: DocRow, b: Pick<DocRow, "data" | "manual_sort">) {
  return a.manual_sort === b.manual_sort && JSON.stringify(a.data) === JSON.stringify(b.data ?? {});
}

export const useDoc = create<DocState>((set, get) => {
  const fail = (e: unknown, what: string) => {
    toast.error(`${what}: ${errorMessage(e)}`);
  };

  /** After a failed write, re-read the document so the screen matches the database. */
  const reloadAfterFailure = () => {
    const id = get().docId;
    if (id) void get().load(id);
  };

  const applyLocal = (actions: DocAction[]) => {
    const s = get();
    const next = applyActionsLocal(s, actions);
    set({ ...next, version: s.version + 1 });
  };

  const beginWrite = () => set({ pendingWrites: get().pendingWrites + 1, saveState: "saving" });
  const endWrite = (ok: boolean) => {
    const pendingWrites = Math.max(0, get().pendingWrites - 1);
    const saveState: SaveState = !ok ? "error" : pendingWrites ? "saving" : "saved";
    set({ pendingWrites, saveState });
  };

  /** Row ids touched by actions, so realtime echoes for them wait for the write. */
  const rowIdsOf = (actions: DocAction[]) => {
    const ids: number[] = [];
    for (const a of actions) {
      if (a.op === "UpdateRecords") a.records.forEach((r) => ids.push(r.id));
      if (a.op === "RemoveRecords") ids.push(...a.ids);
    }
    return ids;
  };

  /**
   * Sends a bundle of actions. With `optimistic`, the actions are applied
   * locally first; otherwise the server's `applied` list is applied when it
   * returns (needed whenever the server assigns ids, e.g. new rows).
   * Returns null (after telling the user and re-reading the document) on failure.
   */
  const commit = async (
    actions: DocAction[],
    opts: { optimistic?: boolean; undoable?: boolean; what?: string } = {},
  ): Promise<ApplyResult | null> => {
    const docId = get().docId;
    if (!docId || !actions.length) return null;
    const denied = aclDenied(actions);
    if (denied) {
      toast.error(denied);
      return null;
    }
    if (actions.some((a) => a.op === "AddRecords" || a.op === "UpdateRecords")) {
      // Trigger formulas add their values to the same bundle.
      const s = get();
      actions = applyTriggers({ tables: s.tables, columns: s.columns, colsByTable: getDerived().colsByTable, rows: s.rows }, actions, s.me);
      // The other side of two-way references changes in the same bundle.
      actions = [...actions, ...reverseSync(s, actions)];
    }
    if (opts.optimistic) applyLocal(actions);
    const undoable = opts.undoable !== false;
    const ids = rowIdsOf(actions);
    ids.forEach((id) => pendingRows.set(id, (pendingRows.get(id) ?? 0) + 1));
    beginWrite();
    let ok = false;
    try {
      const result = await enqueue(async () => {
        const { data, error } = await supabase().rpc("apply_actions", {
          p_doc: docId,
          p_actions: actions,
          p_undoable: undoable,
          p_source: "app",
        });
        if (error) throw error;
        return data as ApplyResult;
      });
      ok = true;
      if (get().docId === docId) {
        if (!opts.optimistic) applyLocal(result.applied);
        if (undoable) set({ canUndo: true, canRedo: false });
        recheckWritten(docId, result.applied);
      }
      return result;
    } catch (e) {
      if (get().docId === docId) {
        fail(e, opts.what ?? "Could not save changes");
        reloadAfterFailure();
      }
      return null;
    } finally {
      ids.forEach((id) => {
        const n = (pendingRows.get(id) ?? 1) - 1;
        if (n <= 0) pendingRows.delete(id);
        else pendingRows.set(id, n);
      });
      endWrite(ok);
    }
  };

  /**
   * What access rules certainly forbid in a bundle. The server checks
   * everything; this only spares a round trip and a confusing reload.
   */
  const aclDenied = (actions: DocAction[]): string | null => {
    const s = get();
    const acl = s.acl;
    if (!acl) return null;
    const tableName = (id: string) => s.tables.get(id)?.table_id ?? "this table";
    for (const a of actions) {
      if ((a.op === "Add" || a.op === "Update" || a.op === "Remove") && (a.entity === "table" || a.entity === "column") && !acl.structure) {
        return "You don't have permission to change tables and columns in this document";
      }
      if (!acl.ruled) continue;
      if (a.op === "AddRecords" && acl.tables[a.table]?.create === false) return `You don't have permission to add records to ${tableName(a.table)}`;
      if (a.op === "RemoveRecords" && acl.tables[a.table]?.delete === false) return `You don't have permission to delete records of ${tableName(a.table)}`;
      if (a.op === "UpdateRecords") {
        if (acl.tables[a.table]?.update === false) return `You don't have permission to change records of ${tableName(a.table)}`;
        for (const r of a.records) {
          for (const k of Object.keys(r.values)) {
            const c = acl.cols[k];
            if (c && (c.update === false || c.read === false)) {
              const col = s.columns.get(k);
              return `You don't have permission to change ${col?.label || col?.col_id || "this column"}`;
            }
          }
        }
      }
    }
    return null;
  };

  /** Brings two-way references back in agreement (after undo, or rows added without known ids). */
  const repairReverse = () => {
    const fix = reverseRepair(get());
    if (fix.length) void commit(fix, { optimistic: true, undoable: false, what: "Could not update two-way references" });
  };

  /** Runs undo_action / redo_action on the server and applies what it did. */
  const history = async (fn: "undo_action" | "redo_action") => {
    const docId = get().docId;
    if (!docId || !get().canEdit()) return;
    beginWrite();
    let ok = false;
    try {
      const result = await enqueue(async () => {
        const { data, error } = await supabase().rpc(fn, { p_doc: docId });
        if (error) throw error;
        return data as ApplyResult | null;
      });
      ok = true;
      if (get().docId !== docId) return;
      if (!result) {
        set(fn === "undo_action" ? { canUndo: false } : { canRedo: false });
        return;
      }
      applyLocal(result.applied);
      set({ canUndo: !!result.can_undo, canRedo: !!result.can_redo });
      recheckWritten(docId, result.applied);
      repairReverse();
    } catch (e) {
      if (get().docId === docId) {
        fail(e, fn === "undo_action" ? "Undo failed" : "Redo failed");
        reloadAfterFailure();
      }
    } finally {
      endWrite(ok);
    }
  };

  /** Formula rewrites for every column whose formula changes, e.g. after a rename. */
  const formulaRewrites = (columns: Iterable<DocColumn>, rewrite: (c: DocColumn) => string): DocAction[] => {
    const out: DocAction[] = [];
    for (const c of columns) {
      if (!c.formula) continue;
      const next = rewrite(c);
      if (next !== c.formula) out.push({ op: "Update", entity: "column", id: c.id, patch: { formula: next } });
    }
    return out;
  };

  /** Actions creating a table with its columns; returns them with the new table's id. */
  const tableActions = (name?: string, columns?: { label: string; type?: ColumnType }[]) => {
    const s = get();
    const taken = [...s.tables.values()].map((t) => t.table_id);
    const tableId = uniqueIdent(name ? labelToIdent(name, { capitalize: true }) : "Table1", taken);
    const position = Math.max(0, ...[...s.tables.values()].map((t) => t.position)) + 1;
    const id = newId();
    const actions: DocAction[] = [{ op: "Add", entity: "table", row: { id, table_id: tableId, position } }];
    const specs = columns ?? [{ label: "A" }, { label: "B" }, { label: "C" }];
    const usedIds: string[] = [];
    specs.forEach((spec, i) => {
      const colId = uniqueIdent(labelToIdent(spec.label), usedIds);
      usedIds.push(colId);
      actions.push({
        op: "Add",
        entity: "column",
        row: { id: newId(), table_ref: id, col_id: colId, label: spec.label, type: spec.type ?? "Any", position: i + 1 },
      });
    });
    return { id, actions, columns: actions.slice(1).map((a) => (a as { row: Record<string, unknown> }).row) };
  };

  /** Actions creating a widget (and a new table if the spec asks for one). */
  const widgetActions = (pageId: string, spec: NewWidgetSpec, pageWidgets: DocWidget[]) => {
    const actions: DocAction[] = [];
    let tableRef = spec.tableRef;
    let cols: { id: string; type: string; is_formula?: boolean }[];
    if (tableRef === "new") {
      const t = tableActions();
      actions.push(...t.actions);
      tableRef = t.id;
      cols = t.columns.map((c) => ({ id: c.id as string, type: c.type as string, is_formula: false }));
    } else {
      cols = tableColumns(tableRef);
    }
    const position = Math.max(0, ...pageWidgets.map((w) => w.position)) + 1;
    const options: WidgetOptions = {};
    if (spec.type === "chart") {
      const numeric = cols.filter((c) => c.type === "Numeric" || c.type === "Int");
      options.chartType = "bar";
      options.xCol = cols.find((c) => !numeric.includes(c))?.id ?? cols[0]?.id ?? null;
      options.yCols = numeric.slice(0, 1).map((c) => c.id);
      options.aggregate = "sum";
    }
    if (spec.type === "summary") {
      options.groupBy = cols.filter((c) => c.type === "Choice" || c.type === "Ref" || c.type === "Text").slice(0, 1).map((c) => c.id);
    }
    if (spec.type === "calendar") {
      options.calStart = cols.find((c) => c.type === "Date" || c.type === "DateTime")?.id ?? null;
      options.calTitle = cols.find((c) => c.type === "Text")?.id ?? null;
      options.calView = "month";
    }
    if (spec.type === "custom") {
      options.builtin = "markdown";
      options.customAccess = "read";
    }
    if (spec.type === "board" || spec.type === "timeline" || spec.type === "gallery") Object.assign(options, viewDefaults(spec.type, cols, tableRef));
    if (spec.type === "form") {
      options.formItems = defaultFormItems(cols);
      options.formTitle = get().tables.get(tableRef)?.table_id ?? "Form";
    }
    if (spec.linkSource && spec.linkSourceCol && !spec.linkCol) options.linkSourceCol = spec.linkSourceCol;
    const id = newId();
    actions.push({
      op: "Add",
      entity: "widget",
      row: {
        id,
        page_id: pageId,
        table_ref: tableRef,
        type: spec.type,
        title: spec.title ?? "",
        position,
        width: spec.width ?? (pageWidgets.length ? 6 : 12),
        height: spec.type === "card" ? 360 : spec.type === "board" || spec.type === "gallery" ? 520 : 420,
        options,
        link_source: spec.linkSource ?? null,
        link_col: spec.linkCol ?? null,
      },
    });
    return { id, actions };
  };

  const subscribe = (docId: string) => {
    dropChannel();
    const filter = `doc_id=eq.${docId}`;
    const ch = supabase().channel(`doc-${docId}-${++channelSeq}`);
    const tablesToWatch = ["doc_rows", "doc_columns", "doc_tables", "doc_pages", "doc_widgets"] as const;
    for (const table of tablesToWatch) {
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table, filter }, (p) => onChange(table, "INSERT", p.new));
      ch.on("postgres_changes", { event: "UPDATE", schema: "public", table, filter }, (p) => onChange(table, "UPDATE", p.new));
      // Delete events cannot be filtered; unknown ids are simply ignored.
      ch.on("postgres_changes", { event: "DELETE", schema: "public", table }, (p) => onChange(table, "DELETE", p.old));
    }
    ch.subscribe();
    channel = ch;
  };

  // ---- Change notices for documents with access rules. postgres_changes
  // delivers nothing for their rows (row-level security), so the database
  // broadcasts the ids that changed and they're re-read through read_rows.
  let refetchTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeIds = new Set<number>();
  let noticeFull = false;

  const subscribeNotices = async (docId: string) => {
    const seq = noticeSeq;
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    // Signed-out link visitors can't join private channels (they reload to refresh).
    if (!data.session || seq !== noticeSeq || get().docId !== docId) return;
    await sb.realtime.setAuth(data.session.access_token);
    if (seq !== noticeSeq) return;
    const ch = sb.channel(`doc:${docId}`, { config: { private: true } });
    for (const event of ["changes", "computed", "acl"]) {
      ch.on("broadcast", { event }, (msg) => onNotice(docId, event, (msg.payload ?? {}) as Record<string, unknown>));
    }
    ch.subscribe();
    notices = ch;
  };

  const onNotice = (docId: string, event: string, payload: Record<string, unknown>) => {
    const s = get();
    if (s.docId !== docId || s.snapshot) return;
    if (event === "acl") {
      // Rules changed: what this person may see may have changed anywhere.
      if (!s.loading) void get().load(docId);
      return;
    }
    if (!s.acl?.ruled && !s.viewAs) return; // postgres_changes covers documents without rules
    if (event === "changes") {
      if (payload.full) noticeFull = true;
      for (const ids of Object.values((payload.rows ?? {}) as Record<string, number[]>)) {
        // Our own writes in flight come back with their result.
        for (const id of ids) if (!pendingRows.has(Number(id))) noticeIds.add(Number(id));
      }
    } else if (event === "computed") {
      if (!Array.isArray(payload.ids)) noticeFull = true;
      else for (const id of payload.ids as number[]) noticeIds.add(Number(id));
    }
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => void refetchNoticed(docId), 150);
  };

  /**
   * With access rules, a record just written may have become unreadable (or
   * its server formula values changed): re-read it. Notices for our own
   * writes are skipped while in flight, so this covers them.
   */
  const recheckWritten = (docId: string, applied: DocAction[]) => {
    if (!get().acl?.ruled) return;
    for (const a of applied) {
      if (a.op === "AddRecords") a.records.forEach((r) => r.id !== undefined && noticeIds.add(r.id));
      if (a.op === "UpdateRecords") a.records.forEach((r) => noticeIds.add(r.id));
    }
    if (!noticeIds.size) return;
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => void refetchNoticed(docId), 150);
  };

  const refetchNoticed = async (docId: string) => {
    const full = noticeFull;
    const ids = [...noticeIds];
    noticeFull = false;
    noticeIds = new Set();
    if (get().docId !== docId) return;
    if (full) {
      if (!get().loading) await get().load(docId);
      return;
    }
    if (!ids.length) return;
    try {
      const fetched = await readRows(docId, get().viewAs, ids);
      if (get().docId === docId) mergeFetched(ids, fetched);
    } catch {
      // A later notice or reload brings the document up to date.
    }
  };

  /** Puts re-read records in place; ids asked for but not returned are no longer readable. */
  const mergeFetched = (ids: number[], fetched: DocRow[]) => {
    const s = get();
    const rows = new Map(s.rows);
    const copied = new Set<string>();
    const tableRows = (t: string) => {
      if (!copied.has(t)) {
        rows.set(t, new Map(rows.get(t) ?? []));
        copied.add(t);
      }
      return rows.get(t)!;
    };
    const got = new Set(fetched.map((r) => r.id));
    for (const id of ids) {
      if (got.has(id)) continue;
      for (const [t, m] of s.rows) if (m.has(id)) tableRows(t).delete(id);
    }
    for (const r of fetched) {
      if (!s.tables.has(r.table_ref)) continue;
      tableRows(r.table_ref).set(r.id, { id: r.id, table_ref: r.table_ref, manual_sort: r.manual_sort, data: r.data ?? {}, computed: r.computed ?? {} });
    }
    if (copied.size) set({ rows, version: s.version + 1 });
  };

  const onChange = (table: string, event: string, rec: Record<string, unknown>) => {
    const s = get();
    if (!s.docId || s.loading) return;
    if (event !== "DELETE" && rec.doc_id !== s.docId) return;
    switch (table) {
      case "doc_rows": {
        const id = Number(rec.id);
        if (pendingRows.has(id)) return;
        if (event === "DELETE") {
          for (const [tableRef, map] of s.rows) {
            if (map.has(id)) return applyLocal([{ op: "RemoveRecords", table: tableRef, ids: [id] }]);
          }
          return;
        }
        const row = rec as unknown as DocRow;
        const local = s.rows.get(row.table_ref)?.get(id);
        // Server-side formula results change only `computed`; nothing to redraw.
        if (local && rowsEqual(local, row)) return;
        applyLocal([{ op: "AddRecords", table: row.table_ref, records: [{ id, manual_sort: row.manual_sort, data: row.data ?? {} }] }]);
        break;
      }
      case "doc_columns": {
        const columns = new Map(s.columns);
        if (event === "DELETE") {
          if (!columns.delete(String(rec.id))) return;
        } else columns.set(String(rec.id), rec as unknown as DocColumn);
        set({ columns, version: s.version + 1 });
        break;
      }
      case "doc_tables": {
        const tables = new Map(s.tables);
        if (event === "DELETE") {
          if (!tables.delete(String(rec.id))) return;
        } else tables.set(String(rec.id), rec as unknown as DocTable);
        const rows = s.rows.has(String(rec.id)) || event === "DELETE" ? s.rows : new Map(s.rows).set(String(rec.id), new Map());
        set({ tables, rows, version: s.version + 1 });
        break;
      }
      case "doc_pages": {
        let pages = s.pages.filter((p) => p.id !== rec.id);
        if (event === "DELETE" && pages.length === s.pages.length) return;
        if (event !== "DELETE") pages = sortedPages([...pages, rec as unknown as DocPage]);
        set({ pages, version: s.version + 1 });
        break;
      }
      case "doc_widgets": {
        const widgets = new Map(s.widgets);
        if (event === "DELETE") {
          if (!widgets.delete(String(rec.id))) return;
        } else widgets.set(String(rec.id), rec as unknown as DocWidget);
        set({ widgets, version: s.version + 1 });
        break;
      }
    }
  };

  return {
    docId: null,
    doc: null,
    role: null,
    loading: false,
    error: null,
    tables: new Map(),
    columns: new Map(),
    rows: new Map(),
    pages: [],
    widgets: new Map(),
    formShares: new Map(),
    version: 0,
    cursors: {},
    canUndo: false,
    canRedo: false,
    pendingWrites: 0,
    saveState: "saved",
    me: null,
    snapshot: null,
    acl: null,
    viewAs: null,

    async load(docId) {
      const token = ++loadToken;
      const sameDoc = get().docId === docId;
      const viewAs = sameDoc ? get().viewAs : null;
      set({ loading: true, error: null, docId, snapshot: null, viewAs, ...(sameDoc ? {} : { cursors: {}, canUndo: false, canRedo: false, acl: null }) });
      // Subscribe before fetching so changes made while loading aren't missed
      // (events are ignored until the snapshot below is in place).
      subscribe(docId);
      void subscribeNotices(docId);
      try {
        const sb = supabase();
        const aclReq = sb.rpc("acl_info", { p_doc: docId, p_as: viewAs });
        const [docRes, roleRes, tablesRes, colsRes, pagesRes, widgetsRes, sharesRes, undoRes] = await Promise.all([
          sb.from("documents").select("*").eq("id", docId).maybeSingle(),
          sb.rpc("doc_role", { p_doc: docId }),
          sb.from("doc_tables").select("*").eq("doc_id", docId),
          sb.from("doc_columns").select("*").eq("doc_id", docId),
          sb.from("doc_pages").select("*").eq("doc_id", docId),
          sb.from("doc_widgets").select("*").eq("doc_id", docId),
          sb.from("form_shares").select("*").eq("doc_id", docId),
          sb.rpc("undo_state", { p_doc: docId }),
        ]);
        for (const r of [docRes, roleRes, tablesRes, colsRes, pagesRes, widgetsRes, sharesRes, undoRes]) if (r.error) throw r.error;
        if (!docRes.data) throw new Error("This document doesn't exist or you don't have access to it.");
        const aclRes = await aclReq;
        if (aclRes.error && !missingFunction(aclRes.error)) throw aclRes.error;
        const acl = aclRes.error ? null : (aclRes.data as AclInfo);
        // Documents with access rules (and "view as") are read through the filtered path.
        const rowList =
          acl && (acl.ruled || viewAs)
            ? await readRows(docId, viewAs)
            : await fetchAll<DocRow>((from, to) => sb.from("doc_rows").select(ROW_FIELDS).eq("doc_id", docId).order("id").range(from, to));
        const hidden = new Set(acl?.hidden_cols ?? []);
        if (token !== loadToken) return;
        const tables = new Map((tablesRes.data as DocTable[]).map((t) => [t.id, t]));
        const rows = new Map<string, Map<number, DocRow>>();
        for (const t of tables.keys()) rows.set(t, new Map());
        for (const r of rowList) rows.get(r.table_ref)?.set(r.id, r);
        const undo = (undoRes.data ?? {}) as { can_undo?: boolean; can_redo?: boolean };
        const { data: auth } = await sb.auth.getUser();
        let me: FormulaUser | null = null;
        if (auth.user) {
          const { data: profile } = await sb.from("profiles").select("full_name,email").eq("id", auth.user.id).maybeSingle();
          me = {
            Email: auth.user.email ?? profile?.email ?? "",
            Name: profile?.full_name ?? "",
            UserID: auth.user.id,
            Access: (roleRes.data as string | null) ?? null,
          };
        }
        if (token !== loadToken) return;
        set({
          doc: docRes.data as DocumentRec,
          role: roleRes.data as Role,
          acl,
          tables,
          columns: new Map((colsRes.data as DocColumn[]).filter((c) => !hidden.has(c.id)).map((c) => [c.id, c])),
          rows,
          pages: sortedPages(pagesRes.data as DocPage[]),
          widgets: new Map((widgetsRes.data as DocWidget[]).map((w) => [w.id, w])),
          formShares: new Map((sharesRes.data as FormShare[]).map((f) => [f.widget_id, f])),
          canUndo: !!undo.can_undo,
          canRedo: !!undo.can_redo,
          me,
          loading: false,
          version: get().version + 1,
        });
      } catch (e) {
        if (token !== loadToken) return;
        set({ loading: false, error: errorMessage(e) });
      }
    },

    async setViewAs(email) {
      const s = get();
      if (!s.docId || (email && s.role !== "owner")) return;
      const next = email?.trim() || null;
      if (next === s.viewAs) return;
      if (next) {
        // Check the person first, so a typo doesn't replace the document with an error.
        const { error } = await supabase().rpc("acl_info", { p_doc: s.docId, p_as: next });
        if (error) {
          toast.error(errorMessage(error));
          return;
        }
      }
      set({ viewAs: next });
      await get().load(s.docId);
      if (get().error && next) {
        // Couldn't show that person's view: go back to our own.
        const message = get().error;
        set({ viewAs: null });
        await get().load(s.docId);
        toast.error(message ?? "Could not view the document as that person");
      }
    },

    async loadSnapshot(docId, snapshotId) {
      const token = ++loadToken;
      dropChannel();
      set({ loading: true, error: null, docId, cursors: {}, canUndo: false, canRedo: false });
      try {
        const sb = supabase();
        const [docRes, roleRes, snapRes] = await Promise.all([
          sb.from("documents").select("*").eq("id", docId).maybeSingle(),
          sb.rpc("doc_role", { p_doc: docId }),
          sb.rpc("get_snapshot", { p_id: snapshotId }),
        ]);
        for (const r of [docRes, roleRes, snapRes]) if (r.error) throw r.error;
        const snap = snapRes.data as { id: number; doc_id: string; kind: string; label: string | null; created_at: string; content: Record<string, Record<string, unknown>[]> };
        if (!docRes.data || snap.doc_id !== docId) throw new Error("This snapshot doesn't exist or you can't see it.");
        if (token !== loadToken) return;
        const c = snap.content;
        const tables = new Map((c.tables as unknown as DocTable[]).map((t) => [t.id, { ...t, doc_id: docId }]));
        const rows = new Map<string, Map<number, DocRow>>();
        for (const t of tables.keys()) rows.set(t, new Map());
        for (const r of c.rows as unknown as DocRow[]) rows.get(r.table_ref)?.set(r.id, { id: r.id, table_ref: r.table_ref, manual_sort: r.manual_sort, data: r.data ?? {} });
        set({
          doc: docRes.data as DocumentRec,
          role: "viewer",
          tables,
          columns: new Map((c.columns as unknown as DocColumn[]).map((col) => [col.id, { ...col, doc_id: docId, options: col.options ?? {} }])),
          rows,
          pages: sortedPages((c.pages as unknown as DocPage[]).map((p) => ({ ...p, doc_id: docId }))),
          widgets: new Map((c.widgets as unknown as DocWidget[]).map((w) => [w.id, { ...w, doc_id: docId, options: w.options ?? {} }])),
          formShares: new Map(),
          snapshot: { id: snap.id, kind: snap.kind, label: snap.label, created_at: snap.created_at, realRole: roleRes.data as Role },
          loading: false,
          version: get().version + 1,
        });
      } catch (e) {
        if (token !== loadToken) return;
        set({ loading: false, error: errorMessage(e) });
      }
    },

    unload() {
      loadToken++;
      dropChannel();
      set({
        loading: false,
        error: null,
        docId: null,
        doc: null,
        tables: new Map(),
        columns: new Map(),
        rows: new Map(),
        pages: [],
        widgets: new Map(),
        formShares: new Map(),
        canUndo: false,
        canRedo: false,
        saveState: "saved",
        snapshot: null,
        acl: null,
        viewAs: null,
        version: get().version + 1,
      });
    },

    canEdit() {
      const s = get();
      if (s.snapshot || s.doc?.deleted_at || s.viewAs) return false;
      return s.role === "owner" || s.role === "editor";
    },

    async setCells(changes, opts = {}) {
      if (!changes.length || !get().canEdit()) return;
      const s = get();
      const real: CellChange[] = [];
      for (const c of changes) {
        const row = s.rows.get(c.tableRef)?.get(c.rowId);
        if (!row) continue;
        const before = row.data[c.colId] ?? null;
        if (JSON.stringify(before) === JSON.stringify(c.value)) continue;
        real.push(c);
      }
      if (!real.length) return;
      await commit(cellUpdates(real), { optimistic: true, undoable: opts.undoable });
    },

    async addRows(tableRef, newRows, opts = {}) {
      if (!get().canEdit() || !newRows.length) return [];
      const existing = [...(get().rows.get(tableRef)?.values() ?? [])];
      let maxSort = existing.reduce((m, r) => Math.max(m, r.manual_sort), 0);
      const records = newRows.map((r) => ({ data: r.data, manual_sort: r.manual_sort ?? (maxSort += 1) }));
      const created: DocRow[] = [];
      for (let i = 0; i < records.length; i += 1000) {
        const result = await commit([{ op: "AddRecords", table: tableRef, records: records.slice(i, i + 1000) }], {
          undoable: opts.undoable,
          what: "Could not add rows",
        });
        if (!result) break;
        const applied = result.applied[0];
        if (applied?.op === "AddRecords") {
          for (const r of applied.records) {
            created.push({ id: r.id!, table_ref: tableRef, manual_sort: r.manual_sort ?? 0, data: r.data ?? {} });
          }
        }
      }
      // New rows' ids were unknown when the bundle was built: sync two-way references now.
      if (created.length) repairReverse();
      return created;
    },

    async deleteRows(tableRef, ids, opts = {}) {
      if (!ids.length || !get().canEdit()) return;
      await commit([{ op: "RemoveRecords", table: tableRef, ids }], {
        optimistic: true,
        undoable: opts.undoable,
        what: "Could not delete rows",
      });
    },

    async moveRows(tableRef, ids, beforeId, values) {
      if (!ids.length || !get().canEdit()) return;
      const rows = get().rows.get(tableRef);
      if (!rows) return;
      const moving = new Set(ids);
      const order = getDerived().engine.rowIds(tableRef);
      const rest = order.filter((id) => !moving.has(id));
      const at = beforeId === null ? rest.length : Math.max(0, rest.indexOf(beforeId));
      const prev = at > 0 ? rows.get(rest[at - 1])?.manual_sort : undefined;
      const next = at < rest.length ? rows.get(rest[at])?.manual_sort : undefined;
      const moved = order.filter((id) => moving.has(id));
      // Evenly spaced positions strictly between the neighbours.
      const lo = prev ?? (next !== undefined ? next - moved.length - 1 : 0);
      const hi = next ?? lo + moved.length + 1;
      const step = (hi - lo) / (moved.length + 1);
      const records = moved.map((id, i) => ({ id, values: { ...(values ?? {}) }, manual_sort: lo + step * (i + 1) }));
      await commit([{ op: "UpdateRecords", table: tableRef, records }], { optimistic: true, what: "Could not move rows" });
    },

    async undo() {
      await history("undo_action");
    },

    async redo() {
      await history("redo_action");
    },

    async addTable(name, columns) {
      if (!get().canEdit()) return null;
      const t = tableActions(name, columns);
      const result = await commit(t.actions, { what: "Could not create table" });
      return result ? (get().tables.get(t.id) ?? null) : null;
    },

    async renameTable(tableRef, name) {
      const s = get();
      const table = s.tables.get(tableRef);
      if (!table || !s.canEdit()) return false;
      const taken = [...s.tables.values()].filter((t) => t.id !== tableRef).map((t) => t.table_id);
      const newTableId = uniqueIdent(labelToIdent(name, { capitalize: true }), taken);
      if (newTableId === table.table_id) return true;
      const actions: DocAction[] = [
        { op: "Update", entity: "table", id: tableRef, patch: { table_id: newTableId } },
        ...formulaRewrites(s.columns.values(), (c) => renameTableInFormula(c.formula, table.table_id, newTableId)),
      ];
      return !!(await commit(actions, { optimistic: true, what: "Could not rename table" }));
    },

    async deleteTable(tableRef) {
      if (!get().canEdit()) return;
      await commit([{ op: "Remove", entity: "table", id: tableRef }], { optimistic: true, what: "Could not delete table" });
    },

    async addColumn(tableRef, init = {}, position) {
      if (!get().canEdit()) return null;
      const existing = tableColumns(tableRef);
      const label = init.label ?? nextColumnLetter(existing.map((c) => c.label));
      const colId = uniqueIdent(init.col_id ?? labelToIdent(label), existing.map((c) => c.col_id));
      const pos = position ?? Math.max(0, ...existing.map((c) => c.position)) + 1;
      const id = newId();
      const result = await commit(
        [
          {
            op: "Add",
            entity: "column",
            row: {
              id,
              table_ref: tableRef,
              col_id: colId,
              label,
              type: init.type ?? "Any",
              is_formula: init.is_formula ?? false,
              formula: init.formula ?? "",
              options: init.options ?? {},
              position: pos,
            },
          },
        ],
        { what: "Could not add column" },
      );
      return result ? (get().columns.get(id) ?? null) : null;
    },

    async updateColumn(colId, patch, opts = {}) {
      const s = get();
      const before = s.columns.get(colId);
      if (!before || !s.canEdit()) return false;
      const next: DocColumn = { ...before, ...patch, options: { ...before.options, ...(patch.options ?? {}) } };
      if (patch.options && Object.keys(patch.options).length === 0) next.options = {};
      // Keep identifiers valid and unique within the table.
      if (patch.col_id !== undefined && patch.col_id !== before.col_id) {
        const siblings = tableColumns(before.table_ref).filter((c) => c.id !== colId).map((c) => c.col_id);
        next.col_id = uniqueIdent(labelToIdent(patch.col_id), siblings);
      }
      // Converting stored values when a data column changes type.
      const typeChanged = next.type !== before.type && !next.is_formula && !before.is_formula;
      let conversions: CellChange[] = [];
      if (typeChanged) {
        const ctx = displayCtx();
        for (const row of s.rows.get(before.table_ref)?.values() ?? []) {
          const raw = row.data[colId];
          if (raw === undefined || raw === null) continue;
          const converted = convertValue(raw, before, next, ctx, ctx.engine.safeValue(before, row.id));
          if (JSON.stringify(converted) !== JSON.stringify(raw)) {
            conversions.push({ tableRef: before.table_ref, rowId: row.id, colId, value: converted });
          }
        }
      }
      // Turning a formula column into data keeps its current values.
      if (before.is_formula && next.is_formula === false) {
        const engine = getDerived().engine;
        const ctx = displayCtx();
        conversions = [];
        for (const row of s.rows.get(before.table_ref)?.values() ?? []) {
          const v = engine.safeValue(before, row.id);
          if (v instanceof FormulaError) continue;
          const text = displayValue(ctx, before, v);
          conversions.push({ tableRef: before.table_ref, rowId: row.id, colId, value: parseInput(next, text, ctx) });
        }
      }
      // Only send fields that changed; the server replaces each field (incl. options) whole.
      const prev = columnPatch(before);
      const wanted = columnPatch(next);
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(wanted)) if (JSON.stringify(prev[k]) !== JSON.stringify(v)) changed[k] = v;
      const actions: DocAction[] = [];
      if (Object.keys(changed).length) actions.push({ op: "Update", entity: "column", id: colId, patch: changed });
      actions.push(...cellUpdates(conversions));
      if (next.col_id !== before.col_id) {
        // Every formula that refers to the column follows the rename, in any table:
        // $Old, $Ref.Old, Table.lookupRecords(Old=…), sort_by="Old", conditional styles…
        const analyzer = new DependencyAnalyzer({ tables: [...s.tables.values()], columns: [...s.columns.values()] });
        const rewrite = (formula: string, tableRef: string) => renameColumnRefs(formula, tableRef, before, next.col_id, analyzer);
        const cols = [...s.columns.values()].map((c) => (c.id === colId ? { ...c, formula: next.formula, options: next.options } : c));
        actions.push(...formulaRewrites(cols, (c) => rewrite(c.formula, c.table_ref)));
        for (const c of cols) {
          const rules = c.options.rules?.map((r) => ({ ...r, formula: rewrite(r.formula, c.table_ref) }));
          const cond = c.options.dropdownCondition ? rewrite(c.options.dropdownCondition, c.table_ref) : c.options.dropdownCondition;
          const rulesChanged = !!rules && JSON.stringify(rules) !== JSON.stringify(c.options.rules);
          if (rulesChanged || cond !== c.options.dropdownCondition) {
            const options = { ...c.options, ...(rules ? { rules } : {}), ...(cond ? { dropdownCondition: cond } : {}) };
            actions.push({ op: "Update", entity: "column", id: c.id, patch: { options } });
          }
        }
        for (const w of s.widgets.values()) {
          const tableRef = w.table_ref;
          if (!tableRef || !w.options.rowRules?.length) continue;
          const rowRules = w.options.rowRules.map((r) => ({ ...r, formula: rewrite(r.formula, tableRef) }));
          if (JSON.stringify(rowRules) !== JSON.stringify(w.options.rowRules)) {
            actions.push({ op: "Update", entity: "widget", id: w.id, patch: { options: { ...w.options, rowRules } } });
          }
        }
      }
      if (!actions.length) return true;
      return !!(await commit(actions, { optimistic: true, undoable: opts.undoable, what: "Could not update column" }));
    },

    async addTwoWay(colId) {
      const s = get();
      const col = s.columns.get(colId);
      const target = col?.options.refTable;
      if (!col || !target || !s.canEdit() || (col.type !== "Ref" && col.type !== "RefList")) return;
      const own = s.tables.get(col.table_ref);
      const siblings = tableColumns(target).map((c) => c.col_id);
      const label = own?.table_id ?? "Records";
      const id = newId();
      const position = Math.max(0, ...tableColumns(target).map((c) => c.position)) + 1;
      const reverse: DocColumn = {
        id,
        doc_id: col.doc_id,
        table_ref: target,
        col_id: uniqueIdent(labelToIdent(label), siblings),
        label,
        type: "RefList",
        is_formula: false,
        formula: "",
        options: { refTable: col.table_ref, visibleCol: tableColumns(col.table_ref)[0]?.id ?? null, reverseCol: col.id, reverseSecondary: true },
        position,
      };
      const actions: DocAction[] = [
        { op: "Add", entity: "column", row: reverse as unknown as Record<string, unknown> },
        { op: "Update", entity: "column", id: col.id, patch: { options: { ...col.options, reverseCol: id, reverseSecondary: undefined } } },
      ];
      const fill = initialReverse(col, reverse, s.rows);
      if (fill) actions.push(fill);
      await commit(actions, { optimistic: true, what: "Could not add the two-way reference" });
    },

    async removeTwoWay(colId) {
      const s = get();
      const col = s.columns.get(colId);
      const other = col?.options.reverseCol ? s.columns.get(col.options.reverseCol) : undefined;
      if (!col || !s.canEdit()) return;
      const strip = (c: DocColumn): DocAction => {
        const options = { ...c.options };
        delete options.reverseCol;
        delete options.reverseSecondary;
        return { op: "Update", entity: "column", id: c.id, patch: { options } };
      };
      await commit(other ? [strip(col), strip(other)] : [strip(col)], { optimistic: true, what: "Could not update the reference" });
    },

    async deleteColumn(colId) {
      if (!get().columns.has(colId) || !get().canEdit()) return;
      await commit([{ op: "Remove", entity: "column", id: colId }], { optimistic: true, what: "Could not delete column" });
    },

    async renameDoc(name) {
      const s = get();
      if (!s.doc || !name.trim()) return;
      const { error } = await supabase().from("documents").update({ name: name.trim() }).eq("id", s.doc.id);
      if (error) return fail(error, "Could not rename document");
      set({ doc: { ...s.doc, name: name.trim() } });
    },

    async saveSettings(settings) {
      const s = get();
      if (!s.doc || !s.canEdit()) return false;
      const clean: DocSettings = {};
      for (const k of ["locale", "currency", "timezone"] as const) if (settings[k]) clean[k] = settings[k];
      const { data, error } = await supabase().rpc("set_doc_settings", { p_doc: s.doc.id, p_settings: clean });
      if (error) {
        fail(error, "Could not save document settings");
        return false;
      }
      // Version bump: formatting and TODAY() are recomputed everywhere.
      set({ doc: { ...get().doc!, settings: (data as DocSettings | null) ?? clean }, version: get().version + 1 });
      return true;
    },

    async addPage(name, widget) {
      const s = get();
      if (!s.canEdit()) return null;
      const id = newId();
      const position = Math.max(0, ...s.pages.map((p) => p.position)) + 1;
      const w = widgetActions(id, widget, []);
      const result = await commit(
        [{ op: "Add", entity: "page", row: { id, name: name.trim() || "Untitled", position } }, ...w.actions],
        { what: "Could not add page" },
      );
      return result ? (get().pages.find((p) => p.id === id) ?? null) : null;
    },

    async renamePage(pageId, name) {
      if (!name.trim() || !get().canEdit()) return;
      await commit([{ op: "Update", entity: "page", id: pageId, patch: { name: name.trim() } }], {
        optimistic: true,
        what: "Could not rename page",
      });
    },

    async movePage(pageId, delta) {
      const pages = get().pages;
      const i = pages.findIndex((p) => p.id === pageId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= pages.length || !get().canEdit()) return;
      const a = pages[i];
      const b = pages[j];
      await commit(
        [
          { op: "Update", entity: "page", id: a.id, patch: { position: b.position } },
          { op: "Update", entity: "page", id: b.id, patch: { position: a.position } },
        ],
        { optimistic: true, what: "Could not move page" },
      );
    },

    async deletePage(pageId) {
      if (!get().canEdit()) return;
      await commit([{ op: "Remove", entity: "page", id: pageId }], { optimistic: true, what: "Could not delete page" });
    },

    async addWidget(pageId, spec) {
      if (!get().canEdit()) return null;
      const onPage = [...get().widgets.values()].filter((w) => w.page_id === pageId);
      const w = widgetActions(pageId, spec, onPage);
      const result = await commit(w.actions, { what: "Could not add widget" });
      return result ? (get().widgets.get(w.id) ?? null) : null;
    },

    async updateWidget(id, patch) {
      const s = get();
      const before = s.widgets.get(id);
      if (!before) return;
      const next = { ...before, ...patch, options: { ...before.options, ...(patch.options ?? {}) } };
      set({ widgets: new Map(s.widgets).set(id, next), version: s.version + 1 });
      if (!s.canEdit()) return; // viewers can still sort/filter locally
      const changed: Record<string, unknown> = {};
      for (const k of Object.keys(patch) as (keyof DocWidget)[]) {
        if (k === "id" || k === "doc_id" || k === "table_ref") continue;
        changed[k] = next[k];
      }
      if (!Object.keys(changed).length) return;
      // Already applied locally above (optimistic), so a slower echo of an
      // earlier tweak can't overwrite a newer one. View tweaks (sort, filters,
      // sizes) aren't worth an undo step.
      await commit([{ op: "Update", entity: "widget", id, patch: changed }], {
        optimistic: true,
        undoable: false,
        what: "Could not save widget",
      });
    },

    async reorderWidgets(ids) {
      const s = get();
      if (!s.canEdit()) return;
      const actions: DocAction[] = [];
      ids.forEach((id, i) => {
        const w = s.widgets.get(id);
        if (w && w.position !== i + 1) actions.push({ op: "Update", entity: "widget", id, patch: { position: i + 1 } });
      });
      if (actions.length) await commit(actions, { optimistic: true, undoable: false, what: "Could not move widget" });
    },

    async duplicateWidget(id) {
      const s = get();
      const w = s.widgets.get(id);
      if (!w || !s.canEdit()) return null;
      const siblings = [...s.widgets.values()].filter((x) => x.page_id === w.page_id).sort((a, b) => a.position - b.position);
      const k = siblings.findIndex((x) => x.id === id);
      const copyId = newId();
      const row = { ...w, id: copyId, title: w.title ? `${w.title} (copy)` : "", position: between(w.position, siblings[k + 1]?.position) };
      const result = await commit([{ op: "Add", entity: "widget", row: row as unknown as Record<string, unknown> }], { optimistic: true, what: "Could not duplicate widget" });
      return result ? (get().widgets.get(copyId) ?? null) : null;
    },

    async deleteWidget(id) {
      if (!get().canEdit()) return;
      await commit([{ op: "Remove", entity: "widget", id }], { optimistic: true, what: "Could not remove widget" });
    },

    setCursor(widgetId, rowId) {
      if (get().cursors[widgetId] === rowId) return;
      set({ cursors: { ...get().cursors, [widgetId]: rowId } });
    },

    async setFormShare(widgetId, active) {
      const existing = get().formShares.get(widgetId);
      const res = existing
        ? await supabase().from("form_shares").update({ is_active: active }).eq("id", existing.id).select().single()
        : await supabase().from("form_shares").insert({ widget_id: widgetId, doc_id: get().docId, is_active: active }).select().single();
      if (res.error) {
        fail(res.error, "Could not update form sharing");
        return null;
      }
      set({ formShares: new Map(get().formShares).set(widgetId, res.data as FormShare) });
      return res.data as FormShare;
    },
  };
});
