// Calendar widget: date maths and event layout, kept free of React so it can
// be tested. Events work in local "wall clock" time: a Date column's value
// (UTC midnight in the engine) becomes local midnight of the same day.
import type { CalendarView, CellValue, ColumnType } from "./types";
import { fromWallClock, toWallClock } from "@engine/zone";

export interface CalEvent {
  id: number;
  start: Date;
  /** Exclusive end. All-day events end at local midnight after their last day. */
  end: Date;
  allDay: boolean;
  title: string;
  color: string;
}

export const DAY_MS = 86_400_000;
export const SNAP_MIN = 15;

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Whole local days from a to b (ignores daylight-saving hour shifts). */
export const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday of the week containing d. */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

/** The 6 weeks shown for the month containing d. */
export function monthGrid(d: Date): Date[] {
  const first = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export function viewDays(view: CalendarView, d: Date): Date[] {
  if (view === "month") return monthGrid(d);
  if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(d), i));
  return [startOfDay(d)];
}

/** Moves the anchor date one view back (-1) or forward (+1). */
export function stepAnchor(view: CalendarView, d: Date, dir: -1 | 1): Date {
  if (view === "month") return new Date(d.getFullYear(), d.getMonth() + dir, 1);
  return addDays(d, view === "week" ? 7 * dir : dir);
}

/**
 * An engine value (Date) as local wall-clock time; Date columns become local
 * midnight. DateTime values show the clock of `tz` (the document's time zone)
 * when one is given.
 */
export function toLocal(v: unknown, type: ColumnType, tz?: string | null): Date | null {
  if (!(v instanceof Date) || isNaN(v.getTime())) return null;
  if (type === "Date") return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  try {
    return toWallClock(v, tz);
  } catch {
    return new Date(v.getTime());
  }
}

/** What a Date or DateTime column stores for a local (wall-clock) time. */
export function fromLocal(d: Date, type: ColumnType, tz?: string | null): CellValue {
  if (type === "Date") return dayKey(d);
  try {
    return fromWallClock(d, tz).toISOString();
  } catch {
    return d.toISOString();
  }
}

/**
 * Builds an event from raw start/end values. Without a usable end, an
 * all-day event lasts one day and a timed one an hour.
 */
export function makeEvent(
  id: number,
  start: unknown,
  end: unknown,
  startType: ColumnType,
  endType: ColumnType | null,
  title: string,
  color: string,
  tz?: string | null,
): CalEvent | null {
  const s = toLocal(start, startType, tz);
  if (!s) return null;
  const allDay = startType === "Date";
  let e = endType ? toLocal(end, endType, tz) : null;
  if (allDay) {
    // A Date end is the last day, inclusive.
    e = e ? addDays(startOfDay(e), 1) : null;
    if (!e || e <= s) e = addDays(s, 1);
  } else if (!e || e <= s) {
    e = addMinutes(s, 60);
  }
  return { id, start: s, end: e, allDay, title, color };
}

/** Events touching the local day d. */
export function eventsOn(events: CalEvent[], d: Date): CalEvent[] {
  const from = startOfDay(d).getTime();
  const to = addDays(startOfDay(d), 1).getTime();
  return events.filter((e) => e.start.getTime() < to && e.end.getTime() > from);
}

/** Whether an event is drawn in the all-day row of week/day views. */
export const inAllDayRow = (e: CalEvent) => e.allDay || e.end.getTime() - e.start.getTime() >= DAY_MS;

export interface Placed {
  event: CalEvent;
  /** Minutes from midnight, clipped to the day. */
  top: number;
  bottom: number;
  col: number;
  cols: number;
}

/** Side-by-side columns for timed events on one day that overlap. */
export function layoutDay(events: CalEvent[], d: Date): Placed[] {
  const day0 = startOfDay(d).getTime();
  const items = events
    .filter((e) => !inAllDayRow(e))
    .map((event) => ({
      event,
      top: Math.max(0, (event.start.getTime() - day0) / 60_000),
      bottom: Math.min(24 * 60, (event.end.getTime() - day0) / 60_000),
      col: 0,
      cols: 1,
    }))
    .filter((p) => p.bottom > p.top)
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  // Group events that overlap (directly or through others), then give each a column.
  let group: Placed[] = [];
  let groupEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const p of group) {
      let c = ends.findIndex((end) => end <= p.top);
      if (c < 0) c = ends.length;
      ends[c] = p.bottom;
      p.col = c;
    }
    for (const p of group) p.cols = ends.length;
    group = [];
  };
  for (const p of items) {
    if (p.top >= groupEnd && group.length) flush();
    group.push(p);
    groupEnd = Math.max(groupEnd, p.bottom);
  }
  if (group.length) flush();
  return items;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function viewTitle(view: CalendarView, d: Date): string {
  if (view === "month") return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (view === "day") return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const a = startOfWeek(d);
  const b = addDays(a, 6);
  const fmt = (x: Date, year: boolean) => x.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
  return `${fmt(a, a.getFullYear() !== b.getFullYear())} – ${fmt(b, true)}`;
}

export function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
