import { describe, expect, it } from "vitest";
import { addDays, dayKey, eventsOn, fromLocal, inAllDayRow, layoutDay, makeEvent, monthGrid, startOfWeek, stepAnchor, toLocal } from "../calendar";
import { combine } from "@/components/doc/ChartSummaryWidgets";
import { defaultFormItems, formItemsOf, isFilled, publicItems, toStored } from "../forms";

const utc = (s: string) => new Date(`${s}T00:00:00Z`);

describe("calendar dates", () => {
  it("weeks start on Monday and a month shows six of them", () => {
    expect(dayKey(startOfWeek(new Date(2026, 10, 11)))).toBe("2026-11-09");
    const grid = monthGrid(new Date(2026, 10, 15));
    expect(grid).toHaveLength(42);
    expect(dayKey(grid[0])).toBe("2026-10-26");
    expect(dayKey(grid[41])).toBe("2026-12-06");
  });

  it("Date values become local days and go back unchanged", () => {
    const d = toLocal(utc("2026-03-29"), "Date")!;
    expect(dayKey(d)).toBe("2026-03-29");
    expect(fromLocal(addDays(d, 2), "Date")).toBe("2026-03-31");
  });

  it("DateTime values keep the instant", () => {
    const v = new Date("2026-11-20T08:30:00.000Z");
    expect(fromLocal(toLocal(v, "DateTime")!, "DateTime")).toBe("2026-11-20T08:30:00.000Z");
  });

  it("all-day events end after their last day; timed ones default to an hour", () => {
    const a = makeEvent(1, utc("2026-11-10"), utc("2026-11-12"), "Date", "Date", "Trip", "#fff")!;
    expect(dayKey(a.start)).toBe("2026-11-10");
    expect(dayKey(a.end)).toBe("2026-11-13");
    expect(eventsOn([a], new Date(2026, 10, 12))).toHaveLength(1);
    expect(eventsOn([a], new Date(2026, 10, 13))).toHaveLength(0);
    const t = makeEvent(2, new Date(2026, 10, 10, 9), null, "DateTime", null, "Call", "#fff")!;
    expect(t.end.getHours()).toBe(10);
    expect(inAllDayRow(t)).toBe(false);
    expect(makeEvent(3, "not a date", null, "Date", null, "x", "#fff")).toBeNull();
  });

  it("an end before the start is ignored", () => {
    const e = makeEvent(1, new Date(2026, 0, 5, 10), new Date(2026, 0, 5, 9), "DateTime", "DateTime", "x", "#fff")!;
    expect(e.end.getTime() - e.start.getTime()).toBe(3600_000);
  });

  it("overlapping events sit side by side", () => {
    const day = new Date(2026, 10, 10);
    const ev = (id: number, h1: number, h2: number) => makeEvent(id, new Date(2026, 10, 10, h1), new Date(2026, 10, 10, h2), "DateTime", "DateTime", "", "")!;
    const placed = layoutDay([ev(1, 9, 11), ev(2, 10, 12), ev(3, 13, 14)], day);
    const by = Object.fromEntries(placed.map((p) => [p.event.id, p]));
    expect(by[1].cols).toBe(2);
    expect(by[2].col).toBe(1);
    expect(by[3].cols).toBe(1);
    expect(by[1].top).toBe(540);
  });

  it("steps by month, week or day", () => {
    expect(dayKey(stepAnchor("month", new Date(2026, 0, 31), 1))).toBe("2026-02-01");
    expect(dayKey(stepAnchor("week", new Date(2026, 0, 31), -1))).toBe("2026-01-24");
    expect(dayKey(stepAnchor("day", new Date(2026, 0, 31), 1))).toBe("2026-02-01");
  });
});

describe("forms", () => {
  it("older forms turn their field list into a layout", () => {
    const items = formItemsOf({ options: { fields: [{ col: "c1", required: true }, { col: "c2" }] } });
    expect(items.map((i) => i.kind === "field" && i.col)).toEqual(["c1", "c2"]);
    expect(items[0].kind === "field" && items[0].required).toBe(true);
  });

  it("new forms list every column but formulas", () => {
    const items = defaultFormItems([{ id: "a" }, { id: "b", is_formula: true }, { id: "c", is_formula: false }]);
    expect(items.map((i) => i.kind === "field" && i.col)).toEqual(["a", "c"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it("converts inputs to stored values", () => {
    expect(toStored("Numeric", "2.5")).toBe(2.5);
    expect(toStored("Ref", "61")).toBe(61);
    expect(toStored("Text", "  ")).toBeNull();
    expect(toStored("ChoiceList", [])).toBeNull();
    expect(toStored("DateTime", "2026-11-20T10:30")).toMatch(/^2026-11-20T\d\d:30:00\.000Z$/);
    expect(isFilled(false)).toBe(true);
    expect(isFilled("")).toBe(false);
  });

  it("reads definitions from older servers", () => {
    const items = publicItems({ title: "", description: "", submitLabel: "", successMessage: "", fields: [{ id: "x", label: "X", type: "Text", options: {}, required: false, help: "" }] });
    expect(items[0]).toMatchObject({ kind: "field", width: "full" });
  });
});

describe("chart totals", () => {
  it("sums, averages, and adds error sizes in quadrature", () => {
    expect(combine([1, 2, 3], "sum")).toBe(6);
    expect(combine([1, 2, 3], "avg")).toBe(2);
    expect(combine([3, 4], "sum", true)).toBe(5);
    expect(combine([], "avg")).toBe(0);
  });
});
