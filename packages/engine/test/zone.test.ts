import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine";
import { FormulaError } from "../src/values";
import { fromWallClock, isValidTimeZone, toWallClock, zonedParts, zonedToUtc } from "../src/zone";
import { fixture } from "./fixture";

describe("time zones", () => {
  it("reads wall-clock parts in a zone", () => {
    const t = new Date("2026-07-01T22:30:00Z");
    expect(zonedParts(t, "Europe/Amsterdam")).toMatchObject({ y: 2026, m: 7, d: 2, h: 0, mi: 30 });
    expect(zonedParts(t, "America/New_York")).toMatchObject({ y: 2026, m: 7, d: 1, h: 18, mi: 30 });
    expect(zonedParts(t, "UTC")).toMatchObject({ d: 1, h: 22 });
  });

  it("finds the instant for a wall-clock time, across daylight saving", () => {
    // Amsterdam: UTC+1 in winter, UTC+2 in summer.
    expect(zonedToUtc(2026, 1, 15, 9, 0, 0, "Europe/Amsterdam").toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(zonedToUtc(2026, 7, 15, 9, 0, 0, "Europe/Amsterdam").toISOString()).toBe("2026-07-15T07:00:00.000Z");
    // The day the clocks go forward (29 March 2026, 02:00 -> 03:00).
    expect(zonedToUtc(2026, 3, 29, 12, 0, 0, "Europe/Amsterdam").toISOString()).toBe("2026-03-29T10:00:00.000Z");
    expect(zonedToUtc(2026, 11, 1, 23, 30, 0, "Asia/Kolkata").toISOString()).toBe("2026-11-01T18:00:00.000Z");
  });

  it("round-trips through wall-clock dates", () => {
    const t = new Date("2026-11-12T15:45:00Z");
    for (const tz of ["Europe/Amsterdam", "America/Los_Angeles", "Asia/Tokyo", "Australia/Adelaide", null]) {
      expect(fromWallClock(toWallClock(t, tz), tz).toISOString()).toBe(t.toISOString());
    }
    const w = toWallClock(t, "Asia/Tokyo");
    expect([w.getDate(), w.getHours(), w.getMinutes()]).toEqual([13, 0, 45]);
  });

  it("checks zone names", () => {
    expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(5)).toBe(false);
  });
});

describe("TODAY() and the document's time zone", () => {
  afterEach(() => vi.useRealTimers());
  const today = (opts: { timezone?: string | null }, formula = "TODAY()") => {
    const data = fixture();
    const v = new Engine(data, opts).evaluate(formula, "to", 10);
    return v instanceof Date ? v.toISOString().slice(0, 10) : v instanceof FormulaError ? v.code : v;
  };

  it("is today in the document's zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T23:30:00Z"));
    expect(today({ timezone: "Europe/Amsterdam" })).toBe("2026-11-13");
    expect(today({ timezone: "America/New_York" })).toBe("2026-11-12");
    expect(today({ timezone: "UTC" })).toBe("2026-11-12");
  });

  it("takes a zone of its own, and refuses unknown ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T23:30:00Z"));
    expect(today({ timezone: "America/New_York" }, 'TODAY("Asia/Tokyo")')).toBe("2026-11-13");
    expect(today({ timezone: "UTC" }, 'TODAY(tz="Asia/Tokyo")')).toBe("2026-11-13");
    expect(today({}, 'TODAY("Mars/Olympus")')).toBe("#ValueError");
  });

  it("uses DocData.timezone when no option is given (the formula worker)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T23:30:00Z"));
    const data = { ...fixture(), timezone: "Asia/Tokyo" };
    const v = new Engine(data).evaluate("TODAY()", "to", 10) as Date;
    expect(v.toISOString().slice(0, 10)).toBe("2026-11-13");
  });
});
