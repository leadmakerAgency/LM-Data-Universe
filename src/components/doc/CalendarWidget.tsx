"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { useWidgetRows } from "./CardWidgets";
import {
  SNAP_MIN,
  addDays,
  addMinutes,
  dayDiff,
  dayKey,
  eventsOn,
  fromLocal,
  inAllDayRow,
  layoutDay,
  makeEvent,
  sameDay,
  startOfDay,
  stepAnchor,
  timeLabel,
  viewDays,
  viewTitle,
  type CalEvent,
} from "@/lib/calendar";
import { CHOICE_PALETTE, choiceColor, displayValue } from "@/lib/format";
import type { CalendarView, CellValue, DocColumn, DocWidget } from "@/lib/types";
import { displayCtx, getDerived, tableColumns, useDoc, type CellChange } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

const HOUR_PX = 44;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hashColor(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return CHOICE_PALETTE[Math.abs(h) % CHOICE_PALETTE.length];
}

/** The calendar's columns, from its options (or sensible guesses). */
export function calendarColumns(widget: DocWidget) {
  const cols = tableColumns(widget.table_ref);
  const o = widget.options;
  const dated = cols.filter((c) => c.type === "Date" || c.type === "DateTime");
  const start = cols.find((c) => c.id === o.calStart && (c.type === "Date" || c.type === "DateTime")) ?? dated[0] ?? null;
  const end = cols.find((c) => c.id === o.calEnd && (c.type === "Date" || c.type === "DateTime") && c.id !== start?.id) ?? null;
  const title = cols.find((c) => c.id === o.calTitle) ?? cols.find((c) => c.type === "Text" && !c.is_formula) ?? null;
  const color = cols.find((c) => c.id === o.calColor) ?? null;
  return { cols, dated, start, end, title, color };
}

type Drag =
  | { kind: "move"; id: number; dayDelta: number; minDelta: number }
  | { kind: "resize"; id: number; minDelta: number };

export function CalendarWidget({ widget }: { widget: DocWidget }) {
  const { ids, link } = useWidgetRows(widget);
  const version = useDoc((s) => s.version);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  // The saved view, until someone switches here.
  const [picked, setView] = useState<CalendarView | null>(null);
  const view: CalendarView = picked ?? widget.options.calView ?? "month";
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [drag, setDrag] = useState<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const { start, end, title, color } = useMemo(() => calendarColumns(widget), [widget, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const canMove = canEdit && !!start && !start.is_formula && (!end || !end.is_formula);
  const canResize = canMove && !!end && end.type === "DateTime" && start?.type === "DateTime";


  const events = useMemo(() => {
    if (!start) return [];
    const { engine } = getDerived();
    const ctx = displayCtx();
    const out: CalEvent[] = [];
    for (const id of ids) {
      const label = title ? displayValue(ctx, title, engine.safeValue(title, id)) : "";
      const cv = color ? displayValue(ctx, color, engine.safeValue(color, id)) : "";
      const bg = !color ? "#E0E7FF" : color.type === "Choice" ? choiceColor(color, cv) : cv ? hashColor(cv) : "#F3F4F6";
      const e = makeEvent(id, engine.safeValue(start, id), end ? engine.safeValue(end, id) : null, start.type, end?.type ?? null, label || `#${id}`, bg);
      if (e) out.push(e);
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.id - b.id);
  }, [ids, start, end, title, color, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Events as they would be after the drag in progress.
  const shown = useMemo(() => {
    if (!drag) return events;
    return events.map((e) => {
      if (e.id !== drag.id) return e;
      if (drag.kind === "resize") return { ...e, end: new Date(Math.max(addMinutes(e.end, drag.minDelta).getTime(), addMinutes(e.start, SNAP_MIN).getTime())) };
      return { ...e, start: addMinutes(addDays(e.start, drag.dayDelta), drag.minDelta), end: addMinutes(addDays(e.end, drag.dayDelta), drag.minDelta) };
    });
  }, [events, drag]);

  // Week and day views open scrolled to the morning.
  useEffect(() => {
    if (view !== "month" && scroller.current) scroller.current.scrollTop = 7.5 * HOUR_PX;
  }, [view]);

  const select = (id: number) => useDoc.getState().setCursor(widget.id, id);
  const open = (id: number) => widget.table_ref && useUi.getState().openRecordCard({ tableRef: widget.table_ref, rowId: id });

  /** Saves a moved or resized event. */
  const commit = (d: Drag) => {
    const e = events.find((x) => x.id === d.id);
    if (!e || !start || !widget.table_ref) return;
    const changes: CellChange[] = [];
    const put = (col: DocColumn, value: CellValue) => changes.push({ tableRef: widget.table_ref!, rowId: e.id, colId: col.id, value });
    if (d.kind === "resize") {
      if (!end || !d.minDelta) return;
      put(end, fromLocal(new Date(Math.max(addMinutes(e.end, d.minDelta).getTime(), addMinutes(e.start, SNAP_MIN).getTime())), end.type));
    } else {
      if (!d.dayDelta && !d.minDelta) return;
      put(start, fromLocal(addMinutes(addDays(e.start, d.dayDelta), d.minDelta), start.type));
      if (end && end.type === start.type) {
        const raw = getDerived().engine.safeValue(end, e.id);
        if (raw instanceof Date) {
          // A Date end is inclusive: move the stored last day, not the exclusive end.
          const last = end.type === "Date" ? addDays(e.end, -1) : e.end;
          put(end, fromLocal(addMinutes(addDays(last, d.dayDelta), d.minDelta), end.type));
        }
      }
    }
    void useDoc.getState().setCells(changes);
  };

  /** Starts dragging an event: across days (data-cal-day targets), and in time grids up and down. */
  const startDrag = (e: React.MouseEvent, ev: CalEvent, kind: "move" | "resize", fromDay: Date, timed: boolean) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let current: Drag | null = null;
    const onMove = (m: MouseEvent) => {
      if (!active && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
      if (!active && !(kind === "resize" ? canResize : canMove)) return;
      active = true;
      const minDelta = timed ? Math.round((m.clientY - sy) / HOUR_PX / (SNAP_MIN / 60)) * SNAP_MIN : 0;
      if (kind === "resize") {
        current = { kind, id: ev.id, minDelta };
      } else {
        const el = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest("[data-cal-day]") as HTMLElement | null;
        const key = el?.dataset.calDay;
        const target = key ? new Date(`${key}T00:00:00`) : fromDay;
        current = { kind, id: ev.id, dayDelta: dayDiff(fromDay, target), minDelta };
      }
      setDrag(current);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDrag(null);
      if (active && current) commit(current);
      else select(ev.id);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const create = async (at: Date, timed: boolean) => {
    if (!canEdit || !start || start.is_formula || !widget.table_ref) return;
    const s = timed ? at : start.type === "DateTime" ? new Date(at.getFullYear(), at.getMonth(), at.getDate(), 9) : at;
    const data: Record<string, CellValue> = { ...(link.newRowDefaults as Record<string, CellValue>), [start.id]: fromLocal(s, start.type) };
    if (end && !end.is_formula) data[end.id] = fromLocal(end.type === "Date" ? s : addMinutes(s, 60), end.type);
    const rows = await useDoc.getState().addRows(widget.table_ref, [{ data }]);
    if (rows[0]) {
      select(rows[0].id);
      open(rows[0].id);
    }
  };

  if (!start) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
        This table has no Date or DateTime column. Add one, then pick it in Widget options.
      </div>
    );
  }
  if (link.waiting) return <div className="flex h-full items-center justify-center text-sm text-gray-400">Select a record in the linked widget.</div>;

  const days = viewDays(view, anchor);
  const today = new Date();

  const chip = (ev: CalEvent, day: Date, timedRow: boolean) => {
    const continues = !sameDay(ev.start, day) && dayDiff(ev.start, day) > 0;
    return (
      <div
        key={`${ev.id}-${dayKey(day)}`}
        onMouseDown={(e) => startDrag(e, ev, "move", day, false)}
        onDoubleClick={(e) => (e.stopPropagation(), open(ev.id))}
        title={`${ev.title}${ev.allDay ? "" : ` · ${timeLabel(ev.start)}`}`}
        style={{ background: ev.color }}
        className={clsx(
          "truncate rounded px-1.5 py-0.5 text-[11px] leading-4 text-gray-800",
          canMove ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          selected === ev.id && "ring-2 ring-brand-500",
          drag?.id === ev.id && "opacity-80 shadow-md",
          continues && "rounded-l-none",
        )}
      >
        {!ev.allDay && !timedRow && sameDay(ev.start, day) && <span className="mr-1 text-gray-500">{timeLabel(ev.start)}</span>}
        {ev.title}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-1.5">
        <Button size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
          Today
        </Button>
        <div className="flex">
          <button className="rounded p-1 text-gray-500 hover:bg-gray-100" title="Previous" onClick={() => setAnchor(stepAnchor(view, anchor, -1))}>
            <ChevronLeft size={16} />
          </button>
          <button className="rounded p-1 text-gray-500 hover:bg-gray-100" title="Next" onClick={() => setAnchor(stepAnchor(view, anchor, 1))}>
            <ChevronRight size={16} />
          </button>
        </div>
        <span className="font-medium text-gray-800">{viewTitle(view, anchor)}</span>
        <div className="flex-1" />
        {canEdit && !start.is_formula && (
          <Button size="sm" variant="ghost" onClick={() => create(view === "month" && !sameDay(anchor, today) ? anchor : startOfDay(today), false)} title="Add an event (or double-click a day)">
            <Plus size={13} /> Event
          </Button>
        )}
        <div className="flex rounded-md border border-gray-200 p-0.5 text-xs">
          {(["month", "week", "day"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={clsx("rounded px-2 py-0.5 capitalize", view === v ? "bg-gray-100 font-medium" : "text-gray-500 hover:text-gray-800")}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "month" ? (
        <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr]">
          <div className="grid grid-cols-7 border-b border-gray-100 text-center text-[11px] font-medium text-gray-500">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid min-h-0 grid-cols-7 grid-rows-6">
            {days.map((day) => {
              const list = eventsOn(shown, day);
              const other = day.getMonth() !== anchor.getMonth();
              return (
                <div
                  key={dayKey(day)}
                  data-cal-day={dayKey(day)}
                  onDoubleClick={() => create(day, false)}
                  className={clsx("flex min-h-0 flex-col gap-0.5 overflow-hidden border-b border-r border-gray-100 p-1", other && "bg-gray-50/70")}
                >
                  <button
                    className={clsx(
                      "self-end rounded-full px-1.5 text-[11px] leading-5",
                      sameDay(day, today) ? "bg-brand-600 font-semibold text-white" : other ? "text-gray-400" : "text-gray-600 hover:bg-gray-100",
                    )}
                    onClick={() => (setAnchor(day), setView("day"))}
                    title="Open this day"
                  >
                    {day.getDate()}
                  </button>
                  {list.slice(0, 3).map((ev) => chip(ev, day, false))}
                  {list.length > 3 && (
                    <button className="text-left text-[11px] text-gray-500 hover:text-brand-700" onClick={() => (setAnchor(day), setView("day"))}>
                      +{list.length - 3} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex border-b border-gray-100">
            <div className="w-12 shrink-0" />
            {days.map((day) => (
              <div key={dayKey(day)} className="min-w-0 flex-1 border-l border-gray-100 px-1 py-1 text-center text-[11px]">
                <span className={clsx("rounded-full px-1.5", sameDay(day, today) ? "bg-brand-600 font-semibold text-white" : "text-gray-600")}>
                  {WEEKDAYS[(day.getDay() + 6) % 7]} {day.getDate()}
                </span>
              </div>
            ))}
          </div>
          <div className="flex border-b border-gray-200">
            <div className="w-12 shrink-0 py-1 pr-1 text-right text-[10px] text-gray-400">all day</div>
            {days.map((day) => (
              <div key={dayKey(day)} data-cal-day={dayKey(day)} onDoubleClick={() => create(day, false)} className="flex min-h-7 min-w-0 flex-1 flex-col gap-0.5 border-l border-gray-100 p-0.5">
                {eventsOn(shown, day)
                  .filter(inAllDayRow)
                  .map((ev) => chip(ev, day, true))}
              </div>
            ))}
          </div>
          <div ref={scroller} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto">
            <div className="flex" style={{ height: 24 * HOUR_PX }}>
              <div className="relative w-12 shrink-0">
                {Array.from({ length: 23 }, (_, h) => (
                  <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-gray-400" style={{ top: (h + 1) * HOUR_PX }}>
                    {timeLabel(new Date(2000, 0, 1, h + 1))}
                  </div>
                ))}
              </div>
              {days.map((day) => (
                <div
                  key={dayKey(day)}
                  data-cal-day={dayKey(day)}
                  className="relative min-w-0 flex-1 border-l border-gray-100"
                  onDoubleClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    const min = Math.floor((e.clientY - box.top) / HOUR_PX / (SNAP_MIN / 60)) * SNAP_MIN;
                    void create(addMinutes(startOfDay(day), min), true);
                  }}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="absolute left-0 right-0 border-t border-gray-100" style={{ top: h * HOUR_PX }} />
                  ))}
                  {sameDay(day, today) && (
                    <div className="pointer-events-none absolute left-0 right-0 z-10 border-t-2 border-red-400" style={{ top: ((today.getHours() * 60 + today.getMinutes()) / 60) * HOUR_PX }} />
                  )}
                  {layoutDay(shown, day).map((p) => (
                    <div
                      key={p.event.id}
                      onMouseDown={(e) => startDrag(e, p.event, "move", day, true)}
                      onDoubleClick={(e) => (e.stopPropagation(), open(p.event.id))}
                      title={`${p.event.title} · ${timeLabel(p.event.start)} – ${timeLabel(p.event.end)}`}
                      style={{
                        top: (p.top / 60) * HOUR_PX,
                        height: Math.max(18, ((p.bottom - p.top) / 60) * HOUR_PX - 2),
                        left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                        width: `calc(${100 / p.cols}% - 4px)`,
                        background: p.event.color,
                      }}
                      className={clsx(
                        "absolute z-20 overflow-hidden rounded border border-white/70 px-1.5 py-0.5 text-[11px] leading-4 text-gray-800 shadow-sm",
                        canMove ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                        selected === p.event.id && "ring-2 ring-brand-500",
                        drag?.id === p.event.id && "opacity-80 shadow-lg",
                      )}
                    >
                      <div className="truncate font-medium">{p.event.title}</div>
                      <div className="truncate text-gray-600">
                        {timeLabel(p.event.start)} – {timeLabel(p.event.end)}
                      </div>
                      {canResize && sameDay(p.event.end, day) && (
                        <div className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize" onMouseDown={(e) => startDrag(e, p.event, "resize", day, true)} />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
