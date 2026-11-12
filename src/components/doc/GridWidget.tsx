"use client";

import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpDown,
  ChevronDown,
  Copy,
  ExternalLink,
  EyeOff,
  Maximize2,
  MessageSquare,
  Filter,
  FunctionSquare,
  MoveLeft,
  MoveRight,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MenuDivider, MenuItem, Popover, useDialogs } from "@/components/ui";
import { CellContent, isRightAligned } from "./CellContent";
import { CellEditor, type Move } from "./CellEditor";
import { AttachmentsDialog } from "./Attachments";
import { attachmentIds } from "@/lib/attachments";
import { cellCss, styleToCss } from "@/lib/styles";
import { RecordRef } from "@engine/values";
import { nowHhmm, startOfTodayIso, todayIso } from "@/lib/format";
import { FilterPopover } from "./FilterPopover";
import { commitCell, commitNewRow, editText, parseClipboard, pasteGrid, toClipboardText } from "@/lib/editing";
import { between } from "@/lib/ids";
import { COLUMN_TYPES, type CellValue, type DocColumn, type DocWidget, type WidgetOptions } from "@/lib/types";
import { filterText, visibleColumns, widgetRows } from "@/lib/view";
import { getDerived, tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";
import { toast } from "@/store/toasts";
import { updateCursor, usePresence, type Peer } from "@/store/presence";
import { threadsByCell, useComments } from "@/store/comments";

const ROW_H = 32;
const GUTTER = 52;
const DEFAULT_W = 150;
const NEW_ROW = -1;

interface Pos {
  rowId: number;
  colId: string;
}

export function GridWidget({ widget, setOptions }: { widget: DocWidget; setOptions: (o: Partial<WidgetOptions>) => void }) {
  const version = useDoc((s) => s.version);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const sourceCursor = useDoc((s) => (widget.link_source ? s.cursors[widget.link_source] : undefined));
  // The search box finds (and highlights) cells; it doesn't filter tables.
  const search = useUi((s) => s.search.trim().toLowerCase());
  const findTarget = useUi((s) => (s.findTarget?.widgetId === widget.id ? s.findTarget : null));
  const setActiveWidget = useUi((s) => s.setActiveWidget);
  const openPanel = useUi((s) => s.openPanel);
  const { confirm } = useDialogs();

  const { ids, link } = useMemo(
    () => widgetRows(widget),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, widget, sourceCursor],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cols = useMemo(() => visibleColumns(widget), [version, widget]);
  const rowIndex = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);
  const colIndex = useMemo(() => new Map(cols.map((c, i) => [c.id, i])), [cols]);

  const [active, setActive] = useState<Pos | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<{ pos: Pos; initial: string; formula?: boolean } | null>(null);
  const [colMenu, setColMenu] = useState<{ el: HTMLElement; col: DocColumn } | null>(null);
  const [filterFor, setFilterFor] = useState<{ el: HTMLElement; col: DocColumn } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [filesFor, setFilesFor] = useState<{ col: DocColumn; rowId: number } | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const widths = { ...(widget.options.colWidths ?? {}), ...liveWidths };
  const widthOf = (c: DocColumn) => widths[c.id] ?? DEFAULT_W;
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = GUTTER;
    for (const c of cols) {
      out.push(x);
      x += widths[c.id] ?? DEFAULT_W;
    }
    out.push(x);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, JSON.stringify(widths)]);
  const totalWidth = lefts[lefts.length - 1] + (canEdit ? 44 : 0);
  // Leftmost visible columns that stay in view while scrolling sideways.
  const frozen = Math.max(0, Math.min(widget.options.frozen ?? 0, cols.length));
  const frozenEdge = lefts[frozen];
  const frozenStyle = (ci: number): React.CSSProperties => (ci < frozen ? { position: "sticky", left: lefts[ci] } : {});
  const rowCount = ids.length + (canEdit && !link.waiting ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const idx = useCallback(
    (p: Pos | null) => {
      if (!p) return null;
      const r = p.rowId === NEW_ROW ? ids.length : rowIndex.get(p.rowId);
      const c = colIndex.get(p.colId);
      if (r === undefined || c === undefined) return null;
      return { r, c };
    },
    [ids.length, rowIndex, colIndex],
  );
  const posAt = useCallback(
    (r: number, c: number): Pos | null => {
      if (!cols.length) return null;
      const cc = Math.max(0, Math.min(c, cols.length - 1));
      const maxR = rowCount - 1;
      if (maxR < 0) return null;
      const rr = Math.max(0, Math.min(r, maxR));
      return { rowId: rr >= ids.length ? NEW_ROW : ids[rr], colId: cols[cc].id };
    },
    [cols, ids, rowCount],
  );

  // Keep a valid cursor: select the first row when nothing (valid) is selected,
  // and follow same-record links from another widget.
  useEffect(() => {
    if (link.recordId !== null && rowIndex.has(link.recordId)) {
      if (active?.rowId !== link.recordId) {
        const p = { rowId: link.recordId, colId: active?.colId ?? cols[0]?.id };
        if (p.colId) {
          setActive(p);
          setAnchor(p);
        }
      }
      return;
    }
    if (!active || !idx(active)) {
      const p = ids.length ? posAt(0, active ? (colIndex.get(active.colId) ?? 0) : 0) : null;
      setActive(p);
      setAnchor(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, cols, link.recordId]);

  // Publish the selected row so linked widgets can follow it, and show
  // collaborators which cell this person is on.
  useEffect(() => {
    const rowId = active && active.rowId !== NEW_ROW ? active.rowId : null;
    useDoc.getState().setCursor(widget.id, rowId);
    if (useUi.getState().activeWidget === widget.id || rowId !== null) updateCursor({ widgetId: widget.id, rowId, colId: active?.colId ?? null });
  }, [active, widget.id]);
  const peers = usePresence((s) => s.peers);
  const comments = useComments((s) => s.comments);
  // Cells with comment threads: true when any thread is still open.
  const commented = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const [key, threads] of threadsByCell(comments)) {
      const [t, row, col] = key.split(":");
      if (t === widget.table_ref) m.set(`${row}:${col}`, threads.some((x) => !x.root.resolved));
    }
    return m;
  }, [comments, widget.table_ref]);
  const openComments = (p: Pos | null) => {
    if (!p || p.rowId === NEW_ROW || !widget.table_ref) return;
    const el = scrollRef.current?.querySelector(`[data-cell="${p.rowId}:${p.colId}"]`);
    const r = el?.getBoundingClientRect();
    useComments.getState().open({ tableRef: widget.table_ref, rowId: p.rowId, colId: p.colId, anchor: r ? { x: r.right + 4, y: r.top } : null });
  };
  const peerAt = useMemo(() => {
    const m = new Map<string, Peer>();
    for (const p of peers) if (p.widgetId === widget.id && p.rowId != null && p.colId) m.set(`${p.rowId}:${p.colId}`, p);
    return m;
  }, [peers, widget.id]);

  const scrollIntoView = useCallback(
    (p: Pos) => {
      const i = idx(p);
      const el = scrollRef.current;
      if (!i || !el) return;
      virtualizer.scrollToIndex(i.r, { align: "auto" });
      if (i.c < frozen) return;
      const left = lefts[i.c] - frozenEdge;
      const right = lefts[i.c + 1];
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [idx, lefts, virtualizer, frozen, frozenEdge],
  );

  const moveTo = (p: Pos | null, extend = false) => {
    if (!p) return;
    setActive(p);
    if (!extend) setAnchor(p);
    scrollIntoView(p);
  };

  // "Find" moved to a cell in this widget.
  useEffect(() => {
    if (!findTarget) return;
    const p = { rowId: findTarget.rowId, colId: findTarget.colId };
    if (!idx(p)) return;
    setActive(p);
    setAnchor(p);
    scrollIntoView(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findTarget?.seq]);

  const range = useMemo(() => {
    const a = idx(anchor);
    const b = idx(active);
    if (!a || !b) return null;
    return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) };
  }, [anchor, active, idx]);

  const rangeRowIds = () => {
    if (!range) return [];
    return ids.slice(range.r0, Math.min(range.r1, ids.length - 1) + 1);
  };

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  const startEdit = (p: Pos, initial?: string) => {
    const col = cols[colIndex.get(p.colId) ?? -1];
    if (!col) return;
    if (col.type === "Attachments" && !col.is_formula) {
      if (p.rowId !== NEW_ROW) return setFilesFor({ col, rowId: p.rowId });
      if (!canEdit || !widget.table_ref) return;
      void useDoc
        .getState()
        .addRows(widget.table_ref, [{ data: link.newRowDefaults as Record<string, CellValue> }])
        .then((created) => {
          if (!created[0]) return;
          moveTo({ rowId: created[0].id, colId: col.id });
          setFilesFor({ col, rowId: created[0].id });
        });
      return;
    }
    if (!canEdit) return;
    if (col.is_formula) {
      // Typing on a formula cell opens its formula; it never replaces it.
      setEditing({ pos: p, initial: col.formula, formula: true });
      return;
    }
    if (p.rowId !== NEW_ROW && col.type === "Bool" && initial === undefined) {
      toggleBool(col, p.rowId);
      return;
    }
    setEditing({ pos: p, initial: initial ?? (p.rowId === NEW_ROW ? "" : editText(col, p.rowId)) });
  };

  const toggleBool = (col: DocColumn, rowId: number) => {
    if (!canEdit || col.is_formula) return;
    const current = useDoc.getState().rows.get(col.table_ref)?.get(rowId)?.data[col.id];
    void useDoc.getState().setCells([{ tableRef: col.table_ref, rowId, colId: col.id, value: !(current === true) }]);
  };

  const commitEdit = async (text: string, move: Move) => {
    const e = editing;
    setEditing(null);
    focusGrid();
    if (!e) return;
    const col = cols[colIndex.get(e.pos.colId) ?? -1];
    if (!col) return;
    let pos = e.pos;
    if (e.formula) {
      if (text !== col.formula) await useDoc.getState().updateColumn(col.id, { formula: text });
    } else if (e.pos.rowId === NEW_ROW) {
      if (text.trim() !== "") {
        const id = await commitNewRow(col, text, link.newRowDefaults);
        if (id) pos = { rowId: id, colId: col.id };
      }
    } else if (text !== e.initial) {
      await commitCell(col, e.pos.rowId, text);
    }
    const i = idx(pos) ?? { r: e.pos.rowId === NEW_ROW ? ids.length : 0, c: colIndex.get(pos.colId) ?? 0 };
    // ids is stale right after adding a row; compute moves from the row's id when possible.
    const r = pos.rowId !== e.pos.rowId ? ids.length : i.r;
    if (move === "down") moveTo(pos.rowId !== e.pos.rowId ? { rowId: NEW_ROW, colId: pos.colId } : posAt(r + 1, i.c));
    else if (move === "right") moveTo(pos.rowId !== e.pos.rowId ? { rowId: pos.rowId, colId: cols[Math.min(i.c + 1, cols.length - 1)].id } : posAt(r, i.c + 1));
    else if (move === "left") moveTo(posAt(r, i.c - 1));
    else if (pos.rowId !== e.pos.rowId) moveTo(pos);
  };

  const clearRange = () => {
    if (!range || !canEdit) return;
    const changes = [];
    for (const rowId of rangeRowIds()) {
      for (let c = range.c0; c <= range.c1; c++) {
        const col = cols[c];
        if (col.is_formula) continue;
        changes.push({ tableRef: col.table_ref, rowId, colId: col.id, value: (col.type === "Bool" ? false : null) as CellValue });
      }
    }
    void useDoc.getState().setCells(changes);
  };

  /** Ctrl+D: copies the top row of the selection into the rows below it (or the row above into a single row). */
  const fillDown = () => {
    if (!range || !canEdit) return;
    const last = Math.min(range.r1, ids.length - 1);
    const single = last <= range.r0;
    const source = single ? range.r0 - 1 : range.r0;
    if (source < 0 || last < range.r0) return;
    const rows = useDoc.getState().rows;
    const changes = [];
    for (let c = range.c0; c <= range.c1; c++) {
      const col = cols[c];
      if (col.is_formula) continue;
      const value = rows.get(col.table_ref)?.get(ids[source])?.data[col.id] ?? null;
      for (let r = single ? range.r0 : range.r0 + 1; r <= last; r++) {
        changes.push({ tableRef: col.table_ref, rowId: ids[r], colId: col.id, value: value as CellValue });
      }
    }
    void useDoc.getState().setCells(changes);
  };

  /** Ctrl+; inserts today's date, Ctrl+Shift+; the current time, into the selected cells. */
  const insertNow = (withTime: boolean) => {
    if (!range || !canEdit) return;
    // "Today" and "now" in the document's time zone (Document settings).
    const now = new Date();
    const today = todayIso();
    const hhmm = nowHhmm();
    const changes = [];
    for (const rowId of rangeRowIds()) {
      for (let c = range.c0; c <= range.c1; c++) {
        const col = cols[c];
        if (col.is_formula) continue;
        let value: CellValue;
        if (col.type === "Date") value = today;
        else if (col.type === "DateTime") value = withTime ? now.toISOString() : startOfTodayIso();
        else if (col.type === "Text" || col.type === "Any") value = withTime ? hhmm : today;
        else continue;
        changes.push({ tableRef: col.table_ref, rowId, colId: col.id, value });
      }
    }
    void useDoc.getState().setCells(changes);
  };

  const copyText = () => {
    if (!range) return "";
    const grid = rangeRowIds().map((rowId) =>
      cols
        .slice(range.c0, range.c1 + 1)
        .map((c) => (c.type === "Attachments" ? attachmentIds(getDerived().engine.safeValue(c, rowId)).join(", ") : filterText(c, rowId))),
    );
    return toClipboardText(grid);
  };

  const copyWithHeaders = async () => {
    if (!range) return;
    const header = cols.slice(range.c0, range.c1 + 1).map((c) => c.label || c.col_id);
    const body = copyText();
    try {
      await navigator.clipboard.writeText(toClipboardText([header]) + "\n" + body);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };

  /** Double-click on a column edge: fit the column to its header and visible values. */
  const autoWidth = (col: DocColumn) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.font = "14px Inter, ui-sans-serif, system-ui, sans-serif";
    let w = ctx.measureText(col.label || col.col_id).width + 48;
    for (const id of ids.slice(0, 2000)) w = Math.max(w, ctx.measureText(filterText(col, id)).width + 24);
    setOptions({ colWidths: { ...(widget.options.colWidths ?? {}), [col.id]: Math.round(Math.max(60, Math.min(600, w))) } });
  };

  // Dragging a column header or a row number to reorder.
  const [drag, setDrag] = useState<{ kind: "col" | "row"; over: number } | null>(null);
  const dragStart = (e: React.MouseEvent, kind: "col" | "row", index: number) => {
    if (!canEdit || e.button !== 0) return;
    const start = kind === "col" ? e.clientX : e.clientY;
    const el = scrollRef.current;
    if (!el) return;
    const rowsMoving = kind === "row" && range && index >= range.r0 && index <= range.r1 ? rangeRowIds() : kind === "row" ? [ids[index]] : [];
    let active = false;
    let over = index;
    const onMove = (ev: MouseEvent) => {
      const pos = kind === "col" ? ev.clientX : ev.clientY;
      if (!active && Math.abs(pos - start) < 6) return;
      if (!active && kind === "row" && widget.options.sort?.length) {
        cleanup();
        toast.info("Clear the sort to reorder rows by dragging.");
        return;
      }
      active = true;
      dragging.current = false;
      const box = el.getBoundingClientRect();
      if (kind === "col") {
        const x = ev.clientX - box.left + el.scrollLeft;
        over = cols.length;
        for (let c = 0; c < cols.length; c++) if (x < (lefts[c] + lefts[c + 1]) / 2) { over = c; break; }
      } else {
        const y = ev.clientY - box.top + el.scrollTop - ROW_H;
        over = Math.max(0, Math.min(ids.length, Math.round(y / ROW_H)));
      }
      setDrag({ kind, over });
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDrag(null);
    };
    const onUp = () => {
      cleanup();
      if (!active) return;
      if (kind === "col") void moveColumnTo(cols[index], over);
      else if (widget.table_ref) void useDoc.getState().moveRows(widget.table_ref, rowsMoving, over < ids.length ? ids[over] : null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Moves a column before the visible column at `over` (or after the last one). */
  const moveColumnTo = async (col: DocColumn, over: number) => {
    const ci = colIndex.get(col.id) ?? -1;
    if (over === ci || over === ci + 1) return;
    const all = tableColumns(col.table_ref).filter((c) => c.id !== col.id);
    let position: number;
    if (over >= cols.length) {
      const last = cols[cols.length - 1];
      const k = all.findIndex((c) => c.id === last.id);
      position = between(last.position, all[k + 1]?.position);
    } else {
      const target = cols[over];
      const k = all.findIndex((c) => c.id === target.id);
      position = between(all[k - 1]?.position, target.position);
    }
    await useDoc.getState().updateColumn(col.id, { position });
  };

  const insertRow = async (where: "above" | "below") => {
    const i = idx(active);
    if (!i || !canEdit || !widget.table_ref) return;
    const order = getDerived().engine.rowIds(widget.table_ref);
    const rows = useDoc.getState().rows.get(widget.table_ref)!;
    const target = active!.rowId === NEW_ROW ? undefined : rows.get(active!.rowId);
    let sort: number | undefined;
    if (target) {
      const k = order.indexOf(target.id);
      const neighbor = rows.get(order[where === "above" ? k - 1 : k + 1]);
      sort = where === "above" ? between(neighbor?.manual_sort, target.manual_sort) : between(target.manual_sort, neighbor?.manual_sort);
    }
    const created = await useDoc.getState().addRows(widget.table_ref, [{ data: link.newRowDefaults as Record<string, CellValue>, manual_sort: sort }]);
    if (created[0]) moveTo({ rowId: created[0].id, colId: active!.colId });
  };

  const duplicateRows = async () => {
    if (!canEdit || !widget.table_ref) return;
    const rows = useDoc.getState().rows.get(widget.table_ref)!;
    const copies = rangeRowIds().map((id) => ({ data: { ...(rows.get(id)?.data ?? {}) } }));
    await useDoc.getState().addRows(widget.table_ref, copies);
  };

  const deleteRows = async () => {
    const targets = rangeRowIds();
    if (!targets.length || !canEdit || !widget.table_ref) return;
    if (targets.length > 1 && !(await confirm({ title: `Delete ${targets.length} rows?`, message: "You can undo this with Ctrl+Z.", confirmLabel: "Delete", danger: true }))) return;
    await useDoc.getState().deleteRows(widget.table_ref, targets);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const i = idx(active);
    const mod = e.ctrlKey || e.metaKey;
    if (!i) return;
    const shift = e.shiftKey;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 1);
    const go = (r: number, c: number) => {
      e.preventDefault();
      moveTo(posAt(r, c), shift);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(mod ? rowCount - 1 : i.r + 1, i.c);
      case "ArrowUp":
        return go(mod ? 0 : i.r - 1, i.c);
      case "ArrowRight":
        return go(i.r, mod ? cols.length - 1 : i.c + 1);
      case "ArrowLeft":
        return go(i.r, mod ? 0 : i.c - 1);
      case "PageDown":
        return go(i.r + page, i.c);
      case "PageUp":
        return go(i.r - page, i.c);
      case "Home":
        return go(mod ? 0 : i.r, 0);
      case "End":
        return go(mod ? rowCount - 1 : i.r, cols.length - 1);
      case "Tab":
        e.preventDefault();
        return moveTo(posAt(i.r, i.c + (shift ? -1 : 1)));
      case "Enter":
      case "F2":
        e.preventDefault();
        if (shift && e.key === "Enter") return void insertRow("below");
        return startEdit(active!);
      case "Escape":
        setAnchor(active);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        if (mod && shift) return void deleteRows();
        return clearRange();
      case " ":
        if (cols[i.c]?.type === "Attachments" && active!.rowId !== NEW_ROW) {
          e.preventDefault();
          return setFilesFor({ col: cols[i.c], rowId: active!.rowId });
        }
        if (cols[i.c]?.type === "Bool" && active!.rowId !== NEW_ROW) {
          e.preventDefault();
          return toggleBool(cols[i.c], active!.rowId);
        }
        if (active!.rowId !== NEW_ROW && widget.table_ref && !mod) {
          e.preventDefault();
          return useUi.getState().openRecordCard({ tableRef: widget.table_ref, rowId: active!.rowId });
        }
        break;
    }
    if (mod && e.altKey && e.code === "KeyM") {
      e.preventDefault();
      return openComments(active);
    }
    if (mod && !e.altKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      return fillDown();
    }
    if (mod && !e.altKey && e.code === "Semicolon") {
      e.preventDefault();
      return insertNow(shift);
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor(posAt(0, 0));
      setActive(posAt(ids.length - 1, cols.length - 1));
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1 && canEdit) {
      e.preventDefault();
      startEdit(active!, e.key);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || !canEdit) return;
    const i = idx(active);
    if (!i) return;
    e.preventDefault();
    const grid = parseClipboard(e.clipboardData.getData("text/plain"));
    if (!grid.length) return;
    // A single value pasted over a range fills the whole range.
    if (range && grid.length === 1 && grid[0].length === 1 && (range.r1 > range.r0 || range.c1 > range.c0)) {
      const fill = Array.from({ length: Math.min(range.r1, ids.length - 1) - range.r0 + 1 }, () =>
        Array.from({ length: range.c1 - range.c0 + 1 }, () => grid[0][0]),
      );
      void pasteGrid(cols, ids, range.r0, range.c0, fill, link.newRowDefaults);
      return;
    }
    const start = range ? { r: range.r0, c: range.c0 } : i;
    void pasteGrid(cols, ids, start.r, start.c, grid, link.newRowDefaults);
  };

  const sortBy = (col: DocColumn, dir: "asc" | "desc") => {
    const rest = (widget.options.sort ?? []).filter((s) => s.col !== col.id);
    setOptions({ sort: [{ col: col.id, dir }, ...rest] });
  };

  const moveColumn = async (col: DocColumn, delta: number) => {
    const all = tableColumns(col.table_ref);
    const k = all.findIndex((c) => c.id === col.id);
    const a = all[k + delta];
    const b = all[k + delta + (delta > 0 ? 1 : -1)];
    if (!a) return;
    const position = delta > 0 ? between(a.position, b?.position) : between(b?.position, a.position);
    await useDoc.getState().updateColumn(col.id, { position });
  };

  const insertColumn = async (col: DocColumn | null, side: "left" | "right") => {
    if (!widget.table_ref || !canEdit) return;
    let position: number | undefined;
    if (col) {
      const all = tableColumns(col.table_ref);
      const k = all.findIndex((c) => c.id === col.id);
      position = side === "left" ? between(all[k - 1]?.position, col.position) : between(col.position, all[k + 1]?.position);
    }
    const created = await useDoc.getState().addColumn(widget.table_ref, {}, position);
    if (created) openPanel({ tab: "column", colId: created.id });
  };

  /** A formula column showing a field of the referenced record: $Customer.Email. */
  const addLookupColumn = async (ref: DocColumn, field: DocColumn) => {
    if (!widget.table_ref) return;
    const all = tableColumns(ref.table_ref);
    const k = all.findIndex((c) => c.id === ref.id);
    const position = between(ref.position, all[k + 1]?.position);
    const many = ref.type === "RefList";
    const type = many ? "Any" : field.type === "Attachments" ? "Any" : field.type;
    const options = many ? {} : { ...field.options, reverseCol: undefined, reverseSecondary: undefined, trigger: undefined, rules: undefined };
    await useDoc.getState().addColumn(
      widget.table_ref,
      {
        label: `${ref.label || ref.col_id} ${field.label || field.col_id}`,
        is_formula: true,
        formula: `$${ref.col_id}.${field.col_id}`,
        type,
        options,
      },
      position,
    );
  };

  const hideColumn = (col: DocColumn) => setOptions({ hidden: [...(widget.options.hidden ?? []), col.id] });

  const deleteColumn = async (col: DocColumn) => {
    const ok = await confirm({
      title: `Delete column “${col.label || col.col_id}”?`,
      message: "Its data is removed from every view of this table. This cannot be undone.",
      confirmLabel: "Delete column",
      danger: true,
    });
    if (ok) await useDoc.getState().deleteColumn(col.id);
  };

  const startResize = (e: React.MouseEvent, col: DocColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(col);
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(50, Math.min(800, startW + ev.clientX - startX));
      setLiveWidths((w) => ({ ...w, [col.id]: latest }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setOptions({ colWidths: { ...(widget.options.colWidths ?? {}), [col.id]: latest } });
      setLiveWidths((w) => {
        const next = { ...w };
        delete next[col.id];
        return next;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const sortDir = (col: DocColumn) => widget.options.sort?.find((s) => s.col === col.id)?.dir;
  const activeIdx = idx(active);
  const editingIdx = editing ? idx(editing.pos) : null;
  const typeIcon = (c: DocColumn) => COLUMN_TYPES.find((t) => t.type === c.type)?.icon ?? "";

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setActiveWidget(widget.id)}
      onCopy={(e) => {
        if (editing) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", copyText());
      }}
      onCut={(e) => {
        if (editing) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", copyText());
        clearRange();
      }}
      onPaste={onPaste}
      className="scroll-thin relative h-full overflow-auto bg-white text-sm outline-none"
    >
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        {/* header */}
        <div className="sticky top-0 z-10 flex border-b border-gray-200 bg-gray-50" style={{ height: ROW_H }}>
          <div className="sticky left-0 z-10 shrink-0 border-r border-gray-200 bg-gray-50" style={{ width: GUTTER }} />
          {cols.map((c, ci) => {
            const dir = sortDir(c);
            const filtered = !!widget.options.filters?.[c.id];
            const selected = range && ci >= range.c0 && ci <= range.c1;
            return (
              <div
                key={c.id}
                className={clsx(
                  "group relative flex shrink-0 cursor-default select-none items-center gap-1 border-r border-gray-200 px-2 text-xs font-medium text-gray-600",
                  selected ? "bg-brand-50 text-brand-800" : ci < frozen && "bg-gray-50",
                  ci < frozen && "z-10",
                  ci === frozen - 1 && "border-r-2 border-r-gray-300",
                )}
                style={{ width: widthOf(c), ...frozenStyle(ci), ...styleToCss(c.options.headerStyle) }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  setAnchor(posAt(0, ci));
                  setActive(posAt(ids.length - 1, ci));
                  focusGrid();
                  dragStart(e, "col", ci);
                }}
                onDoubleClick={() => openPanel({ tab: "column", colId: c.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setColMenu({ el: e.currentTarget, col: c });
                }}
              >
                <span className={clsx("w-4 shrink-0 text-center font-mono text-[11px]", c.is_formula ? "text-brand-600" : "text-gray-400")}>
                  {c.is_formula ? "=" : typeIcon(c)}
                </span>
                <span className="flex-1 truncate" title={`${c.label} ($${c.col_id})`}>
                  {c.label || c.col_id}
                </span>
                {dir && (dir === "asc" ? <ArrowDownAZ size={13} className="text-brand-600" /> : <ArrowUpAZ size={13} className="text-brand-600" />)}
                {filtered && <Filter size={12} className="text-brand-600" />}
                <button
                  className="rounded p-0.5 opacity-0 hover:bg-gray-200 group-hover:opacity-100"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => setColMenu({ el: e.currentTarget, col: c })}
                  title="Column menu"
                >
                  <ChevronDown size={13} />
                </button>
                <div
                  className="absolute right-[-3px] top-0 z-10 h-full w-[6px] cursor-col-resize"
                  onMouseDown={(e) => startResize(e, c)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    autoWidth(c);
                  }}
                  title="Drag to resize, double-click to fit"
                />
              </div>
            );
          })}
          {canEdit && (
            <button
              className="flex w-11 shrink-0 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-brand-600"
              title="Add column"
              onClick={() => insertColumn(null, "right")}
            >
              <Plus size={16} />
            </button>
          )}
        </div>

        {/* body */}
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vr) => {
            const r = vr.index;
            const isNew = r >= ids.length;
            const rowId = isNew ? NEW_ROW : ids[r];
            const rowSelected = range && r >= range.r0 && r <= range.r1;
            return (
              <div key={rowId} className="absolute left-0 flex border-b border-gray-100" style={{ top: vr.start, height: ROW_H, width: totalWidth }}>
                <div
                  className={clsx(
                    "sticky left-0 z-[5] flex shrink-0 select-none items-center justify-center border-r border-gray-200 text-xs",
                    rowSelected ? "bg-brand-100 text-brand-800" : "bg-gray-50 text-gray-400",
                  )}
                  style={{ width: GUTTER }}
                  onMouseDown={(e) => {
                    if (isNew) return;
                    if (e.button === 2 && rowSelected) return;
                    const p0 = posAt(r, 0);
                    const p1 = posAt(r, cols.length - 1);
                    const inSelection = !!range && r >= range.r0 && r <= range.r1 && range.c0 === 0 && range.c1 === cols.length - 1;
                    if (e.shiftKey && anchor) setActive(p1);
                    else if (!inSelection) {
                      setAnchor(p0);
                      setActive(p1);
                    }
                    focusGrid();
                    if (!e.shiftKey) dragStart(e, "row", r);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!isNew) setCtxMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  {isNew ? (
                    <Plus size={13} />
                  ) : (
                    <span className="group/gutter relative flex w-full items-center justify-center">
                      <span className="group-hover/gutter:invisible">{r + 1}</span>
                      <button
                        className="invisible absolute rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-brand-700 group-hover/gutter:visible"
                        title="Open record card (Space)"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => widget.table_ref && useUi.getState().openRecordCard({ tableRef: widget.table_ref, rowId })}
                      >
                        <Maximize2 size={12} />
                      </button>
                    </span>
                  )}
                </div>
                {cols.map((c, ci) => {
                  const inRange = range && r >= range.r0 && r <= range.r1 && ci >= range.c0 && ci <= range.c1;
                  const isActive = activeIdx?.r === r && activeIdx?.c === ci;
                  const raw = isNew ? undefined : useDoc.getState().rows.get(c.table_ref)?.get(rowId)?.data[c.id];
                  return (
                    <div
                      key={c.id}
                      data-cell={`${rowId}:${c.id}`}
                      className={clsx(
                        "group/cell relative flex shrink-0 items-center overflow-hidden border-r border-gray-100 px-2",
                        isNew && "bg-gray-50/60",
                        inRange && !isActive && "grid-range",
                        isActive && "grid-cell-selected",
                        c.is_formula && !isNew && "bg-brand-50/30",
                        isRightAligned(c) && "justify-end",
                        ci < frozen && "grid-frozen z-[4]",
                        ci < frozen && isNew && "grid-new",
                        ci < frozen && c.is_formula && !isNew && "grid-formula",
                        ci === frozen - 1 && "border-r-2 border-r-gray-300",
                        search && !isNew && filterText(c, rowId).toLowerCase().includes(search) && "grid-find",
                        findTarget?.rowId === rowId && findTarget.colId === c.id && "grid-find-current",
                      )}
                      style={{ width: widthOf(c), ...frozenStyle(ci), ...(isNew ? undefined : cellCss(c, rowId, widget.options.rowRules)) }}
                      onMouseDown={(e) => {
                        if (e.button === 2 && inRange) return;
                        const p = { rowId, colId: c.id };
                        if (e.shiftKey) setActive(p);
                        else {
                          setActive(p);
                          setAnchor(p);
                          dragging.current = true;
                        }
                        focusGrid();
                      }}
                      onMouseEnter={() => {
                        if (dragging.current) setActive({ rowId, colId: c.id });
                      }}
                      onDoubleClick={() => startEdit({ rowId, colId: c.id })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!isNew) setCtxMenu({ x: e.clientX, y: e.clientY });
                      }}
                    >
                      {!isNew &&
                        (c.type === "Bool" && !c.is_formula ? (
                          <span
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              e.stopPropagation();
                              setActive({ rowId, colId: c.id });
                              setAnchor({ rowId, colId: c.id });
                              toggleBool(c, rowId);
                              focusGrid();
                            }}
                            className="cursor-pointer"
                          >
                            <CellContent col={c} value={getDerived().engine.safeValue(c, rowId)} raw={raw} />
                          </span>
                        ) : (
                          <CellContent col={c} value={getDerived().engine.safeValue(c, rowId)} raw={raw} />
                        ))}
                      {!isNew && commented.has(`${rowId}:${c.id}`) && (
                        <button
                          className={clsx("absolute right-0 top-0 z-[7] h-0 w-0 border-l-[8px] border-t-[8px] border-l-transparent", commented.get(`${rowId}:${c.id}`) ? "border-t-amber-500" : "border-t-gray-300")}
                          title="Comments"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => openComments({ rowId, colId: c.id })}
                        />
                      )}
                      {!isNew && peerAt.has(`${rowId}:${c.id}`) && (() => {
                        const p = peerAt.get(`${rowId}:${c.id}`)!;
                        return (
                          <span className="pointer-events-none absolute inset-0 z-[6]" style={{ boxShadow: `inset 0 0 0 2px ${p.color}` }}>
                            <span className="absolute right-0 top-0 max-w-[90%] truncate rounded-bl px-1 text-[9px] font-medium leading-[13px] text-white" style={{ background: p.color }}>
                              {p.name}
                            </span>
                          </span>
                        );
                      })()}
                      {!isNew && c.type === "Ref" && (() => {
                        const v = getDerived().engine.safeValue(c, rowId);
                        return v instanceof RecordRef && v.rowId > 0 ? (
                          <button
                            className="absolute right-0.5 top-1/2 hidden -translate-y-1/2 rounded bg-white/90 p-0.5 text-gray-400 hover:text-brand-700 group-hover/cell:block"
                            title="Open the referenced record"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => useUi.getState().openRecordCard({ tableRef: v.tableRef, rowId: v.rowId })}
                          >
                            <ExternalLink size={12} />
                          </button>
                        ) : null;
                      })()}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {drag?.kind === "row" && <div className="pointer-events-none absolute left-0 right-0 z-30 h-0.5 bg-brand-500" style={{ top: drag.over * ROW_H - 1 }} />}
          {drag?.kind === "col" && <div className="pointer-events-none absolute top-0 z-30 w-0.5 bg-brand-500" style={{ left: lefts[drag.over] - 1, height: virtualizer.getTotalSize() }} />}
          {editing && editingIdx && (
            <CellEditor
              key={`${editing.pos.rowId}:${editing.pos.colId}`}
              col={cols[editingIdx.c]}
              rowId={editing.pos.rowId}
              initial={editing.initial}
              formula={editing.formula}
              style={{
                top: editingIdx.r * ROW_H,
                left: lefts[editingIdx.c] + (editingIdx.c < frozen ? (scrollRef.current?.scrollLeft ?? 0) : 0),
                minWidth: widthOf(cols[editingIdx.c]),
                minHeight: ROW_H,
              }}
              onCommit={commitEdit}
              onCancel={() => {
                setEditing(null);
                focusGrid();
              }}
            />
          )}
        </div>
        {link.waiting && (
          <div className="px-4 py-6 text-center text-xs text-gray-400">Select a record in the linked widget to see related rows.</div>
        )}
        {!cols.length && <div className="px-4 py-6 text-center text-sm text-gray-400">This table has no visible columns.</div>}
      </div>

      <Popover anchor={colMenu?.el ?? null} onClose={() => setColMenu(null)}>
        {colMenu && (
          <>
            <MenuItem icon={<Settings2 size={14} />} onClick={() => (openPanel({ tab: "column", colId: colMenu.col.id }), setColMenu(null))}>
              Column options
            </MenuItem>
            {canEdit && (
              <MenuItem
                icon={<FunctionSquare size={14} />}
                onClick={() => (openPanel({ tab: "column", colId: colMenu.col.id, focusFormula: true }), setColMenu(null))}
              >
                {colMenu.col.is_formula ? "Edit formula" : "Set formula"}
              </MenuItem>
            )}
            <MenuDivider />
            <MenuItem icon={<ArrowDownAZ size={14} />} onClick={() => (sortBy(colMenu.col, "asc"), setColMenu(null))}>
              Sort A → Z
            </MenuItem>
            <MenuItem icon={<ArrowUpAZ size={14} />} onClick={() => (sortBy(colMenu.col, "desc"), setColMenu(null))}>
              Sort Z → A
            </MenuItem>
            <MenuItem
              icon={<Filter size={14} />}
              onClick={() => {
                setFilterFor({ el: colMenu.el, col: colMenu.col });
                setColMenu(null);
              }}
            >
              Filter…
            </MenuItem>
            <MenuDivider />
            {canEdit && (
              <>
                <MenuItem icon={<Plus size={14} />} onClick={() => (insertColumn(colMenu.col, "left"), setColMenu(null))}>
                  Insert column left
                </MenuItem>
                <MenuItem icon={<Plus size={14} />} onClick={() => (insertColumn(colMenu.col, "right"), setColMenu(null))}>
                  Insert column right
                </MenuItem>
                <MenuItem icon={<MoveLeft size={14} />} onClick={() => (moveColumn(colMenu.col, -1), setColMenu(null))}>
                  Move left
                </MenuItem>
                <MenuItem icon={<MoveRight size={14} />} onClick={() => (moveColumn(colMenu.col, 1), setColMenu(null))}>
                  Move right
                </MenuItem>
              </>
            )}
            <MenuItem icon={<EyeOff size={14} />} onClick={() => (hideColumn(colMenu.col), setColMenu(null))}>
              Hide in this view
            </MenuItem>
            {canEdit && (colMenu.col.type === "Ref" || colMenu.col.type === "RefList") && colMenu.col.options.refTable && (
              <>
                <MenuDivider />
                <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Add field from {useDoc.getState().tables.get(colMenu.col.options.refTable)?.table_id}
                </div>
                <div className="scroll-thin max-h-48 overflow-y-auto">
                  {tableColumns(colMenu.col.options.refTable).map((t) => (
                    <MenuItem
                      key={t.id}
                      icon={<Plus size={14} />}
                      onClick={() => {
                        void addLookupColumn(colMenu.col, t);
                        setColMenu(null);
                      }}
                    >
                      {t.label || t.col_id}
                    </MenuItem>
                  ))}
                </div>
              </>
            )}
            {(() => {
              const ci = colIndex.get(colMenu.col.id) ?? 0;
              return frozen > 0 && ci < frozen ? (
                <MenuItem icon={<PinOff size={14} />} onClick={() => (setOptions({ frozen: ci }), setColMenu(null))}>
                  {ci === 0 ? "Unfreeze columns" : "Unfreeze from this column"}
                </MenuItem>
              ) : (
                <MenuItem icon={<Pin size={14} />} onClick={() => (setOptions({ frozen: ci + 1 }), setColMenu(null))}>
                  {ci === 0 ? "Freeze this column" : `Freeze ${ci + 1} columns`}
                </MenuItem>
              );
            })()}
            {canEdit && (
              <>
                <MenuDivider />
                <MenuItem icon={<Trash2 size={14} />} danger onClick={() => (deleteColumn(colMenu.col), setColMenu(null))}>
                  Delete column
                </MenuItem>
              </>
            )}
          </>
        )}
      </Popover>

      {filesFor && (
        <AttachmentsDialog
          col={filesFor.col}
          rowId={filesFor.rowId}
          canEdit={canEdit}
          onClose={() => {
            setFilesFor(null);
            focusGrid();
          }}
        />
      )}

      {filterFor && (
        <FilterPopover
          anchor={filterFor.el}
          widget={widget}
          col={filterFor.col}
          onClose={() => setFilterFor(null)}
          onApply={(filters) => setOptions({ filters })}
        />
      )}

      <Popover anchor={ctxMenu} onClose={() => setCtxMenu(null)}>
        {canEdit && (
          <>
            <MenuItem icon={<Plus size={14} />} onClick={() => (insertRow("above"), setCtxMenu(null))}>
              Insert row above
            </MenuItem>
            <MenuItem icon={<Plus size={14} />} onClick={() => (insertRow("below"), setCtxMenu(null))} hint="Shift+Enter">
              Insert row below
            </MenuItem>
            <MenuItem icon={<ArrowDown size={14} />} onClick={() => (fillDown(), setCtxMenu(null))} hint="Ctrl+D">
              Fill down
            </MenuItem>
            <MenuItem icon={<Copy size={14} />} onClick={() => (duplicateRows(), setCtxMenu(null))}>
              Duplicate {rangeRowIds().length > 1 ? `${rangeRowIds().length} rows` : "row"}
            </MenuItem>
            <MenuDivider />
          </>
        )}
        <MenuItem icon={<MessageSquare size={14} />} onClick={() => (openComments(active), setCtxMenu(null))} hint="Ctrl+Alt+M">
          Comment
        </MenuItem>
        <MenuItem icon={<Copy size={14} />} onClick={() => (void copyWithHeaders(), setCtxMenu(null))}>
          Copy with headers
        </MenuItem>
        <MenuItem
          icon={<ArrowUpDown size={14} />}
          onClick={() => {
            setOptions({ sort: [] });
            setCtxMenu(null);
          }}
        >
          Clear sorting
        </MenuItem>
        {canEdit && (
          <MenuItem icon={<Trash2 size={14} />} danger onClick={() => (deleteRows(), setCtxMenu(null))} hint="Ctrl+Shift+Del">
            Delete {rangeRowIds().length > 1 ? `${rangeRowIds().length} rows` : "row"}
          </MenuItem>
        )}
      </Popover>
    </div>
  );
}
