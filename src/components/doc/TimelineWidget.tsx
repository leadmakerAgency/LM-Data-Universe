"use client";

// Timeline (Gantt): one row per record, a bar from its start to its end date
// (a diamond when there is no end). Drag a bar to move it, its ends to resize,
// the dot at its end onto another bar to say "that one waits for this one".
// Arrows show what waits for what; a red one means the order is broken. When
// a bar moves later, the bars waiting for it can be moved along in one step.
import clsx from "clsx";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Select, useDialogs } from "@/components/ui";
import { addDays, fromLocal, toLocal } from "@/lib/calendar";
import { choiceColor, displayValue, formatSettings } from "@/lib/format";
import { ZOOM_PX, dayDate, dayNumber, dependencyBroken, pushDependents, timelineRange, timelineTicks, wouldLoop, type Bar } from "@/lib/timeline";
import type { CellValue, DocColumn, DocWidget, TimelineZoom, WidgetOptions } from "@/lib/types";
import { FormulaError, RecordSet, toNumber } from "@engine/values";
import { displayCtx, getDerived, useDoc, type CellChange } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";
import { useWidgetRows } from "./CardWidgets";
import { tileTitleText } from "./RecordTile";

const ROW_H = 32;
const HEAD_H = 44;
const LEFT_W = 210;
const MAX_ROWS = 1000;

type DragMode = "move" | "start" | "end" | "link";

const fmtDay = (n: number) => dayDate(n).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function TimelineWidget({ widget, setOptions }: { widget: DocWidget; setOptions: (o: Partial<WidgetOptions>) => void }) {
  const { ids, link } = useWidgetRows(widget);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const columns = useDoc((s) => s.columns);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  const { confirm } = useDialogs();
  const o = widget.options;
  const tableRef = widget.table_ref ?? "";
  const editor = (role === "owner" || role === "editor") && !viewingAs;
  const inTable = (id: string | null | undefined) => {
    const c = id ? columns.get(id) : undefined;
    return c && c.table_ref === tableRef ? c : undefined;
  };
  const startCol = inTable(o.tlStart);
  const endCol = inTable(o.tlEnd);
  const groupCol = inTable(o.tlGroup);
  const depsCol = inTable(o.tlDeps);
  const progressCol = inTable(o.tlProgress);
  const colorCol = inTable(o.tileColor);
  const zoom: TimelineZoom = o.tlZoom ?? "week";
  const px = ZOOM_PX[zoom];
  const tz = formatSettings().timezone ?? null;
  const canMove = editor && !!startCol && !startCol.is_formula && (!endCol || !endCol.is_formula);
  const canLink = editor && !!depsCol && !depsCol.is_formula;

  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; mode: DragMode; delta: number; x: number; y: number; over: number | null } | null>(null);
  const { engine } = getDerived();

   
  const model = useMemo(() => {
    const bars = new Map<number, Bar>();
    const undated: number[] = [];
    if (startCol) {
      for (const id of ids.slice(0, MAX_ROWS)) {
        const s = toLocal(engine.safeValue(startCol, id), startCol.type, tz);
        if (!s) {
          undated.push(id);
          continue;
        }
        const e = endCol ? toLocal(engine.safeValue(endCol, id), endCol.type, tz) : null;
        const start = dayNumber(s);
        // A DateTime end at midnight means "until the end of the day before".
        let end = e ? dayNumber(e) - (endCol?.type === "DateTime" && e.getHours() === 0 && e.getMinutes() === 0 && dayNumber(e) > start ? 1 : 0) : start;
        if (end < start) end = start;
        bars.set(id, { id, start, end, milestone: !e });
      }
    }
    const waitsFor = new Map<number, number[]>();
    if (depsCol) {
      for (const id of bars.keys()) {
        const v = engine.safeValue(depsCol, id);
        const list = v instanceof RecordSet ? v.ids.filter((x) => x !== id) : [];
        if (list.length) waitsFor.set(id, list);
      }
    }
    // Rows: grouped (in order of first appearance) or flat.
    const ctx = displayCtx();
    const groups = new Map<string, number[]>();
    for (const id of bars.keys()) {
      let label = "";
      if (groupCol) {
        const v = engine.safeValue(groupCol, id);
        label = (v instanceof FormulaError ? "" : displayValue(ctx, groupCol, v)) || "(blank)";
      }
      const l = groups.get(label);
      if (l) l.push(id);
      else groups.set(label, [id]);
    }
    const rows: ({ kind: "group"; label: string; count: number } | { kind: "bar"; id: number })[] = [];
    for (const [label, list] of groups) {
      if (groupCol) rows.push({ kind: "group", label, count: list.length });
      for (const id of list) rows.push({ kind: "bar", id });
    }
    const rowOf = new Map<number, number>();
    rows.forEach((r, i) => r.kind === "bar" && rowOf.set(r.id, i));
    const today = dayNumber(toLocal(new Date(), "DateTime", tz) ?? new Date());
    const range = timelineRange([...bars.values()], today);
    return { bars, waitsFor, rows, rowOf, undated, today, ...range, ticks: timelineTicks(range.from, range.to, zoom) };
     
  }, [ids, startCol, endCol, groupCol, depsCol, zoom, tz, engine]);

  // Start with today in view.
  const scrolled = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el || scrolled.current || !startCol) return;
    scrolled.current = true;
    el.scrollLeft = Math.max(0, (model.today - model.from) * px - el.clientWidth / 3);
  }, [model.today, model.from, px, startCol]);

  useEffect(() => {
    if (link.recordId !== null && ids.includes(link.recordId)) useDoc.getState().setCursor(widget.id, link.recordId);
  }, [link.recordId, ids, widget.id]);

  if (!startCol) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-sm text-gray-500">
        <p>Choose the date column the bars start on.</p>
        <p className="text-xs text-gray-400">Widget options → Timeline → Starts (and, for bars with a length, Ends).</p>
      </div>
    );
  }
  if (link.waiting) return <div className="flex h-full items-center justify-center text-sm text-gray-400">Select a record in the linked widget.</div>;

  const width = (model.to - model.from + 1) * px;
  const xOf = (day: number) => (day - model.from) * px;

  /** A bar as it is being dragged. */
  const live = (b: Bar): Bar => {
    if (!drag || drag.id !== b.id || drag.mode === "link") return b;
    if (drag.mode === "move") return { ...b, start: b.start + drag.delta, end: b.end + drag.delta };
    if (drag.mode === "start") return { ...b, start: Math.min(b.start + drag.delta, b.end) };
    return { ...b, end: Math.max(b.end + drag.delta, b.start) };
  };

  /** The cell changes that move a record's dates by whole days (times of day are kept). */
  const dateChanges = (id: number, startDelta: number, endDelta: number): CellChange[] => {
    const out: CellChange[] = [];
    const shift = (col: DocColumn | undefined, delta: number) => {
      if (!col || col.is_formula || !delta) return;
      const local = toLocal(engine.safeValue(col, id), col.type, tz);
      if (local) out.push({ tableRef, rowId: id, colId: col.id, value: fromLocal(addDays(local, delta), col.type, tz) });
    };
    shift(startCol, startDelta);
    shift(endCol, endDelta);
    return out;
  };

  const finish = async (id: number, mode: DragMode, delta: number, over: number | null) => {
    if (mode === "link") {
      if (over === null || over === id || !depsCol) return;
      // The bar dropped on waits for the bar dragged from.
      if (wouldLoop(model.waitsFor, over, id)) return toast.info("That would make the two wait for each other.");
      const current = model.waitsFor.get(over) ?? [];
      if (current.includes(id)) return;
      await useDoc.getState().setCells([{ tableRef, rowId: over, colId: depsCol.id, value: [...current, id] }]);
      return;
    }
    if (!delta) return;
    const before = model.bars.get(id);
    if (!before) return;
    const after = live({ ...before });
    const changes = dateChanges(id, after.start - before.start, endCol ? after.end - before.end : 0);
    // Bars that wait for this one and would now start too early.
    const pushes = pushDependents(model.bars, model.waitsFor, new Map([[id, after]]));
    if (pushes.size) {
      const n = pushes.size;
      const ok = await confirm({
        title: `Move ${n === 1 ? "the task" : `the ${n} tasks`} that wait${n === 1 ? "s" : ""} for this one?`,
        message: `“${tileTitleText(tableRef, id, o)}” now ends on ${fmtDay(after.end)}. ${n === 1 ? "One task that waits for it starts" : `${n} tasks that wait for it start`} before that. Moving ${n === 1 ? "it" : "them"} later keeps the order; it is one step you can undo.`,
        confirmLabel: n === 1 ? "Move it too" : "Move them too",
      });
      if (ok) for (const [dep, days] of pushes) changes.push(...dateChanges(dep, days, days));
    }
    if (changes.length) await useDoc.getState().setCells(changes);
  };

  const begin = (e: React.PointerEvent, id: number, mode: DragMode) => {
    if (e.button !== 0 || (mode === "link" ? !canLink : !canMove)) return;
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    let delta = 0;
    let over: number | null = null;
    let active = false;
    const onMove = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - sx) < 4 && mode !== "link") return;
      active = true;
      delta = Math.round((ev.clientX - sx) / px);
      if (mode === "link") {
        const el = (document.elementsFromPoint(ev.clientX, ev.clientY) as HTMLElement[]).find((x) => x.dataset?.bar !== undefined && scroller.current?.contains(x));
        over = el ? Number(el.dataset.bar) : null;
      }
      setDrag({ id, mode, delta, x: ev.clientX, y: ev.clientY, over });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDrag(null);
      if (active) void finish(id, mode, delta, over);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const addRecord = async () => {
    const start = toLocal(new Date(), "DateTime", tz) ?? new Date();
    const data: Record<string, CellValue> = { ...(link.newRowDefaults as Record<string, CellValue>) };
    if (!startCol.is_formula) data[startCol.id] = fromLocal(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9), startCol.type, tz);
    if (endCol && !endCol.is_formula) data[endCol.id] = fromLocal(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 2, 17), endCol.type, tz);
    const made = await useDoc.getState().addRows(tableRef, [{ data }]);
    if (made[0]) {
      useDoc.getState().setCursor(widget.id, made[0].id);
      useUi.getState().openRecordCard({ tableRef, rowId: made[0].id });
    }
  };

  const barColor = (id: number) => {
    const v = colorCol?.type === "Choice" ? engine.safeValue(colorCol, id) : null;
    return colorCol && typeof v === "string" && v ? choiceColor(colorCol, v) : null;
  };
  const progress = (id: number) => {
    if (!progressCol) return null;
    const n = toNumber(engine.safeValue(progressCol, id));
    if (n === null) return null;
    return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
  };

  // Arrows: from the end of what is waited for to the start of what waits.
  const arrows: { d: string; broken: boolean; key: string }[] = [];
  for (const [id, list] of model.waitsFor) {
    const to = model.bars.get(id);
    const row = model.rowOf.get(id);
    if (!to || row === undefined) continue;
    for (const w of list) {
      const from = model.bars.get(w);
      const fromRow = model.rowOf.get(w);
      if (!from || fromRow === undefined) continue;
      const a = live(from);
      const b = live(to);
      const x1 = xOf(a.end + 1);
      const y1 = fromRow * ROW_H + ROW_H / 2;
      const x2 = xOf(b.start);
      const y2 = row * ROW_H + ROW_H / 2;
      const mid = x2 - 10 >= x1 + 8 ? x1 + 8 : x1 + 8;
      const d = x2 - 10 >= x1 + 8 ? `M${x1},${y1} H${mid} V${y2} H${x2 - 2}` : `M${x1},${y1} H${x1 + 8} V${y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2)} H${x2 - 10} V${y2} H${x2 - 2}`;
      arrows.push({ d, broken: dependencyBroken(b, a), key: `${w}>${id}` });
    }
  }

  return (
    <div className="flex h-full flex-col bg-white text-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-xs text-gray-600">
        <Select value={zoom} onChange={(e) => setOptions({ tlZoom: e.target.value as TimelineZoom })} className="!h-7 !w-28 text-xs" aria-label="Zoom">
          <option value="day">Days</option>
          <option value="week">Weeks</option>
          <option value="month">Months</option>
          <option value="quarter">Quarters</option>
          <option value="year">Years</option>
        </Select>
        <button
          className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollLeft = Math.max(0, (model.today - model.from) * px - el.clientWidth / 3);
          }}
        >
          Today
        </button>
        {arrows.some((a) => a.broken) && <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">{arrows.filter((a) => a.broken).length} out of order</span>}
        {model.undated.length > 0 && <span title="Records without a start date aren't on the timeline">{model.undated.length} without a date</span>}
        {ids.length > MAX_ROWS && <span>showing the first {MAX_ROWS.toLocaleString()}</span>}
        <div className="flex-1" />
        {editor && (
          <button className="inline-flex items-center gap-1 rounded px-2 py-1 text-gray-600 hover:bg-gray-100 hover:text-brand-700" onClick={() => void addRecord()}>
            <Plus size={13} /> Add
          </button>
        )}
      </div>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: LEFT_W + width, minHeight: "100%" }}>
          {/* header */}
          <div className="sticky top-0 z-20 flex border-b border-gray-200 bg-gray-50" style={{ height: HEAD_H }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-500" style={{ width: LEFT_W }}>
              {model.bars.size.toLocaleString()} record{model.bars.size === 1 ? "" : "s"}
            </div>
            <div className="relative" style={{ width }}>
              {model.ticks.major.map((t) => (
                <div key={`M${t.day}`} className="absolute top-0 truncate border-l border-gray-200 px-1.5 text-[11px] font-semibold leading-[22px] text-gray-700" style={{ left: xOf(t.day), width: t.span * px, height: 22 }}>
                  {t.span * px > 40 ? t.label : ""}
                </div>
              ))}
              {model.ticks.minor.map((t) => (
                <div key={`m${t.day}`} className="absolute truncate border-l border-gray-200 px-1 text-[10px] leading-[22px] text-gray-500" style={{ left: xOf(t.day), width: t.span * px, top: 22, height: 22 }}>
                  {t.span * px > 16 ? t.label : ""}
                </div>
              ))}
            </div>
          </div>

          {/* rows */}
          <div className="relative" style={{ height: model.rows.length * ROW_H }}>
            {/* grid lines, weekends and today */}
            <div className="pointer-events-none absolute inset-y-0" style={{ left: LEFT_W, width }}>
              {model.ticks.minor.map((t) => (
                <div key={t.day} className="absolute inset-y-0 border-l border-gray-100" style={{ left: xOf(t.day) }} />
              ))}
              {(zoom === "day" || zoom === "week") &&
                Array.from({ length: model.to - model.from + 1 }, (_, i) => model.from + i)
                  .filter((n) => [0, 6].includes(dayDate(n).getUTCDay()))
                  .map((n) => <div key={`w${n}`} className="absolute inset-y-0 bg-gray-50" style={{ left: xOf(n), width: px }} />)}
              <div className="absolute inset-y-0 w-px bg-red-400" style={{ left: xOf(model.today) + px / 2 }} title="Today" />
            </div>

            {model.rows.map((r, i) =>
              r.kind === "group" ? (
                <div key={`g${r.label}`} className="absolute left-0 flex items-center border-b border-gray-100 bg-gray-50/90" style={{ top: i * ROW_H, height: ROW_H, width: LEFT_W + width }}>
                  <div className="sticky left-0 truncate px-3 text-xs font-semibold text-gray-700" style={{ width: LEFT_W }}>
                    {r.label} <span className="font-normal text-gray-400">{r.count}</span>
                  </div>
                </div>
              ) : (
                (() => {
                  const b = live(model.bars.get(r.id)!);
                  const color = barColor(r.id);
                  const done = progress(r.id);
                  const title = tileTitleText(tableRef, r.id, o);
                  const w = Math.max(b.milestone ? 0 : 8, (b.end - b.start + 1) * px);
                  const isSel = selected === r.id;
                  const isOver = drag?.mode === "link" && drag.over === r.id && drag.id !== r.id;
                  return (
                    <div key={r.id} className={clsx("absolute left-0 flex border-b border-gray-100", isSel && "bg-brand-50/50")} style={{ top: i * ROW_H, height: ROW_H, width: LEFT_W + width }}>
                      <button
                        className={clsx("sticky left-0 z-10 shrink-0 truncate border-r border-gray-200 px-3 text-left text-[13px] hover:text-brand-700", isSel ? "bg-brand-50 font-medium" : "bg-white")}
                        style={{ width: LEFT_W }}
                        title={title}
                        onClick={() => useDoc.getState().setCursor(widget.id, r.id)}
                        onDoubleClick={() => useUi.getState().openRecordCard({ tableRef, rowId: r.id })}
                      >
                        {title}
                      </button>
                      <div className="relative" style={{ width }}>
                        {b.milestone ? (
                          <div
                            data-bar={r.id}
                            onPointerDown={(e) => begin(e, r.id, "move")}
                            onClick={() => useDoc.getState().setCursor(widget.id, r.id)}
                            onDoubleClick={() => useUi.getState().openRecordCard({ tableRef, rowId: r.id })}
                            title={`${title}: ${fmtDay(b.start)}`}
                            className={clsx("absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-45 rounded-sm", canMove && "cursor-grab", isOver && "ring-2 ring-brand-400")}
                            style={{ left: xOf(b.start) + px / 2 - 7, background: color ?? "#5a43d9" }}
                          />
                        ) : (
                          <div
                            data-bar={r.id}
                            onPointerDown={(e) => begin(e, r.id, "move")}
                            onClick={() => useDoc.getState().setCursor(widget.id, r.id)}
                            onDoubleClick={() => useUi.getState().openRecordCard({ tableRef, rowId: r.id })}
                            title={`${title}: ${fmtDay(b.start)} to ${fmtDay(b.end)} (${b.end - b.start + 1} day${b.end === b.start ? "" : "s"})`}
                            className={clsx(
                              "group/bar absolute top-1.5 flex select-none items-center overflow-hidden rounded text-[11px] font-medium",
                              canMove && "cursor-grab active:cursor-grabbing",
                              isSel && "ring-2 ring-brand-300",
                              isOver && "ring-2 ring-brand-500",
                            )}
                            style={{ left: xOf(b.start), width: w, height: ROW_H - 12, background: color ?? "#ded9fb", color: "#1f2330" }}
                          >
                            {done !== null && <div className="absolute inset-y-0 left-0 bg-black/15" style={{ width: `${done * 100}%` }} />}
                            <span className="relative truncate px-1.5">{w > 50 ? title : ""}</span>
                            {canMove && (
                              <>
                                <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => begin(e, r.id, "start")} />
                                {endCol && <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => begin(e, r.id, "end")} />}
                              </>
                            )}
                          </div>
                        )}
                        {canLink && (
                          <div
                            title="Drag onto another bar: that one then waits for this one"
                            onPointerDown={(e) => begin(e, r.id, "link")}
                            className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-crosshair rounded-full border border-gray-400 bg-white opacity-40 hover:border-brand-600 hover:opacity-100"
                            style={{ left: xOf(b.end + 1) + 3 }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })()
              ),
            )}

            <svg className="pointer-events-none absolute top-0 z-[5]" style={{ left: LEFT_W, width, height: model.rows.length * ROW_H }}>
              <defs>
                <marker id={`tl-arrow-${widget.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="#6b7280" />
                </marker>
                <marker id={`tl-arrow-red-${widget.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="#dc2626" />
                </marker>
              </defs>
              {arrows.map((a) => (
                <path key={a.key} d={a.d} fill="none" stroke={a.broken ? "#dc2626" : "#6b7280"} strokeWidth={a.broken ? 1.6 : 1.2} markerEnd={`url(#tl-arrow-${a.broken ? "red-" : ""}${widget.id})`} />
              ))}
            </svg>
          </div>
          {model.bars.size === 0 && <p className="px-4 py-6 text-sm text-gray-400">{ids.length ? "None of these records has a start date yet." : "No records."}</p>}
        </div>
      </div>

      {drag && drag.mode !== "link" && drag.delta !== 0 && (
        <div className="pointer-events-none fixed z-50 rounded bg-gray-900/85 px-2 py-1 text-xs text-white" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {(() => {
            const b = live(model.bars.get(drag.id)!);
            return b.milestone ? fmtDay(b.start) : `${fmtDay(b.start)} → ${fmtDay(b.end)}`;
          })()}
        </div>
      )}
      {drag?.mode === "link" && (
        <div className="pointer-events-none fixed z-50 rounded bg-gray-900/85 px-2 py-1 text-xs text-white" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {drag.over !== null && drag.over !== drag.id ? `“${tileTitleText(tableRef, drag.over, o)}” will wait for this` : "Drop on the task that has to wait"}
        </div>
      )}
    </div>
  );
}
