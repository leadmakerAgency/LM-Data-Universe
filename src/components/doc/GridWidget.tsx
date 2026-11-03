"use client";

import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpDown,
  ChevronDown,
  Copy,
  EyeOff,
  Filter,
  FunctionSquare,
  MoveLeft,
  MoveRight,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MenuDivider, MenuItem, Popover, useDialogs } from "@/components/ui";
import { CellContent, isRightAligned } from "./CellContent";
import { CellEditor, type Move } from "./CellEditor";
import { FilterPopover } from "./FilterPopover";
import { commitCell, commitNewRow, editText, parseClipboard, pasteGrid, toClipboardText } from "@/lib/editing";
import { between } from "@/lib/ids";
import { COLUMN_TYPES, type CellValue, type DocColumn, type DocWidget, type WidgetOptions } from "@/lib/types";
import { filterText, visibleColumns, widgetRows } from "@/lib/view";
import { getDerived, tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

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
  const canEdit = role === "owner" || role === "editor";
  const sourceCursor = useDoc((s) => (widget.link_source ? s.cursors[widget.link_source] : undefined));
  const search = useUi((s) => (s.activeWidget === widget.id ? s.search : ""));
  const setActiveWidget = useUi((s) => s.setActiveWidget);
  const openPanel = useUi((s) => s.openPanel);
  const { confirm } = useDialogs();

  const { ids, link } = useMemo(
    () => widgetRows(widget, { search }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, widget, search, sourceCursor],
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

  // Publish the selected row so linked widgets can follow it.
  useEffect(() => {
    const rowId = active && active.rowId !== NEW_ROW ? active.rowId : null;
    useDoc.getState().setCursor(widget.id, rowId);
  }, [active, widget.id]);

  const scrollIntoView = useCallback(
    (p: Pos) => {
      const i = idx(p);
      const el = scrollRef.current;
      if (!i || !el) return;
      virtualizer.scrollToIndex(i.r, { align: "auto" });
      const left = lefts[i.c] - GUTTER;
      const right = lefts[i.c + 1];
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [idx, lefts, virtualizer],
  );

  const moveTo = (p: Pos | null, extend = false) => {
    if (!p) return;
    setActive(p);
    if (!extend) setAnchor(p);
    scrollIntoView(p);
  };

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
    if (!col || !canEdit) return;
    if (col.is_formula) {
      setEditing({ pos: p, initial: initial ?? col.formula, formula: true });
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

  const copyText = () => {
    if (!range) return "";
    const grid = rangeRowIds().map((rowId) => cols.slice(range.c0, range.c1 + 1).map((c) => filterText(c, rowId)));
    return toClipboardText(grid);
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
        if (cols[i.c]?.type === "Bool" && active!.rowId !== NEW_ROW) {
          e.preventDefault();
          return toggleBool(cols[i.c], active!.rowId);
        }
        break;
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
                  selected && "bg-brand-50 text-brand-800",
                )}
                style={{ width: widthOf(c) }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  setAnchor(posAt(0, ci));
                  setActive(posAt(ids.length - 1, ci));
                  focusGrid();
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
                <div className="absolute right-[-3px] top-0 z-10 h-full w-[6px] cursor-col-resize" onMouseDown={(e) => startResize(e, c)} />
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
                    if (e.shiftKey && anchor) setActive(p1);
                    else {
                      setAnchor(p0);
                      setActive(p1);
                    }
                    focusGrid();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!isNew) setCtxMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  {isNew ? <Plus size={13} /> : r + 1}
                </div>
                {cols.map((c, ci) => {
                  const inRange = range && r >= range.r0 && r <= range.r1 && ci >= range.c0 && ci <= range.c1;
                  const isActive = activeIdx?.r === r && activeIdx?.c === ci;
                  const raw = isNew ? undefined : useDoc.getState().rows.get(c.table_ref)?.get(rowId)?.data[c.id];
                  return (
                    <div
                      key={c.id}
                      className={clsx(
                        "relative flex shrink-0 items-center overflow-hidden border-r border-gray-100 px-2",
                        isNew && "bg-gray-50/60",
                        inRange && !isActive && "grid-range",
                        isActive && "grid-cell-selected",
                        c.is_formula && !isNew && "bg-brand-50/30",
                        isRightAligned(c) && "justify-end",
                      )}
                      style={{ width: widthOf(c) }}
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
                    </div>
                  );
                })}
              </div>
            );
          })}
          {editing && editingIdx && (
            <CellEditor
              key={`${editing.pos.rowId}:${editing.pos.colId}`}
              col={cols[editingIdx.c]}
              initial={editing.initial}
              formula={editing.formula}
              style={{
                top: editingIdx.r * ROW_H,
                left: lefts[editingIdx.c],
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
            <MenuItem icon={<Copy size={14} />} onClick={() => (duplicateRows(), setCtxMenu(null))}>
              Duplicate {rangeRowIds().length > 1 ? `${rangeRowIds().length} rows` : "row"}
            </MenuItem>
            <MenuDivider />
          </>
        )}
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
