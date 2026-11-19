// Timeline (Gantt) maths without React: days on a scale, the header's ticks,
// and what moving one bar means for the bars that wait for it.
import type { TimelineZoom } from "./types";

export const DAY_MS = 86_400_000;

/** Pixels per day at each zoom level. */
export const ZOOM_PX: Record<TimelineZoom, number> = { day: 44, week: 18, month: 6, quarter: 2.4, year: 0.9 };

export interface Bar {
  id: number;
  /** Whole days since 1970, by the calendar date shown to the user. */
  start: number;
  /** Last day, inclusive. Equal to `start` for one-day bars and milestones. */
  end: number;
  milestone: boolean;
}

/** The day number of a date's calendar day (its local year, month and day). */
export const dayNumber = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
/** The calendar day of a day number, as a UTC date (use the getUTC* getters). */
export const dayDate = (n: number) => new Date(n * DAY_MS);

/** The days a timeline shows: all bars and today, with room on both sides, at least `minDays` wide. */
export function timelineRange(bars: Bar[], today: number, minDays = 45): { from: number; to: number } {
  let from = today;
  let to = today;
  for (const b of bars) {
    if (b.start < from) from = b.start;
    if (b.end > to) to = b.end;
  }
  from -= 7;
  to += 21;
  if (to - from + 1 < minDays) to = from + minDays - 1;
  return { from, to };
}

export interface Tick {
  day: number;
  label: string;
  /** Days this tick covers (to the next one, or the end). */
  span: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function steps(from: number, to: number, starts: (d: Date) => boolean, label: (d: Date) => string): Tick[] {
  const out: Tick[] = [];
  for (let n = from; n <= to; n++) {
    const d = dayDate(n);
    if (n === from || starts(d)) out.push({ day: n, label: label(d), span: 1 });
    else out[out.length - 1].span++;
  }
  return out;
}

/** The two header rows for a range: big units on top, small ones below. */
export function timelineTicks(from: number, to: number, zoom: TimelineZoom): { major: Tick[]; minor: Tick[] } {
  const month = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const year = (d: Date) => String(d.getUTCFullYear());
  const firstOfMonth = (d: Date) => d.getUTCDate() === 1;
  const firstOfYear = (d: Date) => d.getUTCDate() === 1 && d.getUTCMonth() === 0;
  const firstOfQuarter = (d: Date) => d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0;
  switch (zoom) {
    case "day":
      return { major: steps(from, to, firstOfMonth, month), minor: steps(from, to, () => true, (d) => String(d.getUTCDate())) };
    case "week":
      return { major: steps(from, to, firstOfMonth, month), minor: steps(from, to, (d) => d.getUTCDay() === 1, (d) => String(d.getUTCDate())) };
    case "month":
      return { major: steps(from, to, firstOfYear, year), minor: steps(from, to, firstOfMonth, (d) => MONTHS[d.getUTCMonth()]) };
    case "quarter":
      return { major: steps(from, to, firstOfYear, year), minor: steps(from, to, firstOfQuarter, (d) => `Q${Math.floor(d.getUTCMonth() / 3) + 1}`) };
    default:
      return { major: steps(from, to, () => false, () => ""), minor: steps(from, to, firstOfYear, year) };
  }
}

/** A dependency is broken when a bar starts before something it waits for has ended. */
export const dependencyBroken = (bar: Bar, waitsFor: Bar) => bar.start <= waitsFor.end;

/**
 * After the bars in `moved` changed, how many days each bar that waits for
 * them (directly or through others) has to move later so that it starts after
 * everything it waits for. `waitsFor`: bar id -> the ids it waits for.
 * Bars already late enough stay where they are; loops are ignored.
 */
export function pushDependents(bars: Map<number, Bar>, waitsFor: Map<number, number[]>, moved: Map<number, Bar>): Map<number, number> {
  const next = new Map<number, number[]>(); // id -> the bars waiting for it
  for (const [id, list] of waitsFor) {
    for (const w of list) {
      const l = next.get(w);
      if (l) l.push(id);
      else next.set(w, [id]);
    }
  }
  const now = new Map(bars);
  for (const [id, b] of moved) now.set(id, b);
  const shifts = new Map<number, number>();
  const queue = [...moved.keys()];
  const seenFrom = new Map<number, number>();
  while (queue.length) {
    const id = queue.shift()!;
    const from = now.get(id);
    if (!from) continue;
    for (const s of next.get(id) ?? []) {
      if (moved.has(s)) continue; // the user placed this one: it stays
      const bar = now.get(s);
      if (!bar) continue;
      const need = from.end + 1 - bar.start;
      if (need <= 0) continue;
      const visits = (seenFrom.get(s) ?? 0) + 1;
      if (visits > 50) continue; // a loop of dependencies
      seenFrom.set(s, visits);
      now.set(s, { ...bar, start: bar.start + need, end: bar.end + need });
      shifts.set(s, (shifts.get(s) ?? 0) + need);
      queue.push(s);
    }
  }
  return shifts;
}

/** True when making `id` wait for `target` would close a loop. */
export function wouldLoop(waitsFor: Map<number, number[]>, id: number, target: number): boolean {
  if (id === target) return true;
  const seen = new Set<number>();
  const stack = [target];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === id) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(waitsFor.get(n) ?? []));
  }
  return false;
}
