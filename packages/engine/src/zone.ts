// Time zones by IANA name ("Europe/Amsterdam"), using Intl only so the same
// code runs in the browser, Node and the Deno formula worker. A missing zone
// (null / undefined / "") means the local zone of the machine running the code.

export interface ZonedParts {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. Throws RangeError for an unknown zone. */
export function zonedParts(d: Date, tz?: string | null): ZonedParts {
  if (!tz) {
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

/** Offset of a zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetAt(t: number, tz: string): number {
  const p = zonedParts(new Date(t), tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** The instant at which a zone's clocks show this wall-clock time. */
export function zonedToUtc(y: number, m: number, d: number, h = 0, mi = 0, s = 0, tz?: string | null): Date {
  if (!tz) return new Date(y, m - 1, d, h, mi, s);
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  // Two passes settle daylight-saving changes between the guess and the answer.
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  return new Date(t);
}

/**
 * An instant as a Date whose *local* fields show the wall-clock time in `tz`
 * (for code that works in local time, such as the calendar). Identity without a zone.
 */
export function toWallClock(d: Date, tz?: string | null): Date {
  if (!tz) return new Date(d.getTime());
  const p = zonedParts(d, tz);
  return new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s, d.getMilliseconds());
}

/** Inverse of toWallClock. */
export function fromWallClock(local: Date, tz?: string | null): Date {
  if (!tz) return new Date(local.getTime());
  const t = zonedToUtc(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), tz);
  return new Date(t.getTime() + local.getMilliseconds());
}
