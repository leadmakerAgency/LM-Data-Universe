// Board and Timeline logic, the defaults new views start with, file kinds and
// the workspace hub spec's consistency.
import { describe, expect, it } from "vitest";
import { RecordRef } from "@engine/values";
import { ago, groupCards, stackKey, stackValue, stacksFor } from "../board";
import { dayDate, dayNumber, dependencyBroken, pushDependents, timelineRange, timelineTicks, wouldLoop, type Bar } from "../timeline";
import { viewDefaults } from "../widgetDefaults";
import { fileKind } from "../attachments";
import { HUB_SPEC, customSectionColumns, sectionKey } from "../hub";

const choice = { type: "Choice" as const, options: { choices: ["Lead", "Won", "Lost"] } };
const ref = { type: "Ref" as const, options: {} };
const bool = { type: "Bool" as const, options: {} };

describe("board", () => {
  it("puts values in stacks", () => {
    expect(stackKey(choice, "Won")).toBe("Won");
    expect(stackKey(choice, null)).toBe("");
    expect(stackKey(choice, "")).toBe("");
    expect(stackKey(ref, new RecordRef("t", 7))).toBe("#7");
    expect(stackKey(ref, new RecordRef("t", 0))).toBe("");
    expect(stackKey(bool, true)).toBe("true");
    expect(stackKey(bool, null)).toBe("false");
  });

  it("stores the right value for a stack", () => {
    expect(stackValue(choice, "Won")).toBe("Won");
    expect(stackValue(choice, "")).toBeNull();
    expect(stackValue(ref, "#7")).toBe(7);
    expect(stackValue(ref, "")).toBeNull();
    expect(stackValue(bool, "true")).toBe(true);
    expect(stackValue(bool, "false")).toBe(false);
  });

  it("lists stacks in choice order, with a stack for empty and for values that are no longer choices", () => {
    expect(stacksFor(choice, [], new Set(["Won"])).map((s) => s.key)).toEqual(["Lead", "Won", "Lost"]);
    expect(stacksFor(choice, [], new Set(["", "Old"])).map((s) => s.key)).toEqual(["", "Lead", "Won", "Lost", "Old"]);
    expect(stacksFor(bool, [], new Set()).map((s) => s.label)).toEqual(["No", "Yes"]);
    expect(stacksFor(ref, [{ id: 1, label: "Acme" }, { id: 2, label: "" }], new Set(["#1", ""])).map((s) => s.label)).toEqual(["Nobody / nothing", "Acme", "#2"]);
  });

  it("groups cards by lane and stack, keeping their order", () => {
    const stack = (id: number) => (id % 2 ? "odd" : "even");
    expect([...groupCards([1, 2, 3, 4], stack, null).get("*")!]).toEqual([["odd", [1, 3]], ["even", [2, 4]]]);
    const lanes = groupCards([1, 2, 3, 4], stack, (id) => (id < 3 ? "a" : "b"));
    expect(lanes.get("a")!.get("odd")).toEqual([1]);
    expect(lanes.get("b")!.get("even")).toEqual([4]);
  });

  it("says how long ago", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(ago(new Date("2026-11-19T11:30:00Z"), now)).toBe("30 min");
    expect(ago(new Date("2026-11-19T02:00:00Z"), now)).toBe("10 h");
    expect(ago(new Date("2026-11-07T12:00:00Z"), now)).toBe("12 d");
  });
});

describe("timeline", () => {
  const bar = (id: number, start: number, end: number): Bar => ({ id, start, end, milestone: false });

  it("counts days by the calendar date", () => {
    const n = dayNumber(new Date(2026, 10, 19, 23, 30));
    expect(dayDate(n).toISOString().slice(0, 10)).toBe("2026-11-19");
    expect(dayNumber(new Date(2026, 10, 20, 0, 5)) - n).toBe(1);
  });

  it("shows all bars and today with some room", () => {
    const r = timelineRange([bar(1, 100, 110), bar(2, 140, 150)], 120);
    expect(r.from).toBe(93);
    expect(r.to).toBe(171);
    expect(timelineRange([], 500).to - timelineRange([], 500).from + 1).toBeGreaterThanOrEqual(45);
  });

  it("builds header ticks that cover every day once", () => {
    const from = dayNumber(new Date(2026, 10, 25));
    const to = dayNumber(new Date(2027, 0, 10));
    for (const zoom of ["day", "week", "month", "quarter", "year"] as const) {
      const t = timelineTicks(from, to, zoom);
      expect(t.minor.reduce((n, x) => n + x.span, 0)).toBe(to - from + 1);
      expect(t.major.reduce((n, x) => n + x.span, 0)).toBe(to - from + 1);
    }
    expect(timelineTicks(from, to, "week").major.map((x) => x.label)).toEqual(["Nov 2026", "Dec 2026", "Jan 2027"]);
    expect(timelineTicks(from, to, "quarter").minor.map((x) => x.label)).toEqual(["Q4", "Q1"]);
  });

  it("knows a broken dependency", () => {
    expect(dependencyBroken(bar(2, 10, 12), bar(1, 5, 10))).toBe(true);
    expect(dependencyBroken(bar(2, 11, 12), bar(1, 5, 10))).toBe(false);
  });

  it("pushes what waits, through chains, only as far as needed", () => {
    const bars = new Map([bar(1, 0, 4), bar(2, 5, 7), bar(3, 8, 9), bar(4, 30, 31)].map((b) => [b.id, b]));
    const waits = new Map([[2, [1]], [3, [2]], [4, [1]]]);
    // 1 now ends on day 9: 2 moves by 5 (to 10..12), 3 by 5 (to 13..14); 4 is late enough.
    const pushes = pushDependents(bars, waits, new Map([[1, bar(1, 0, 9)]]));
    expect([...pushes]).toEqual([[2, 5], [3, 5]]);
    // Moving a bar earlier pushes nothing.
    expect(pushDependents(bars, waits, new Map([[1, bar(1, 0, 2)]])).size).toBe(0);
  });

  it("survives a loop of dependencies and refuses to make one", () => {
    const bars = new Map([bar(1, 0, 4), bar(2, 5, 7)].map((b) => [b.id, b]));
    const loop = new Map([[1, [2]], [2, [1]]]);
    expect(() => pushDependents(bars, loop, new Map([[1, bar(1, 0, 20)]]))).not.toThrow();
    expect(wouldLoop(new Map([[2, [1]]]), 1, 2)).toBe(true);
    expect(wouldLoop(new Map([[2, [1]]]), 3, 2)).toBe(false);
    expect(wouldLoop(new Map(), 1, 1)).toBe(true);
  });
});

describe("new views", () => {
  const cols = [
    { id: "n", type: "Text" },
    { id: "s", type: "Choice" },
    { id: "v", type: "Numeric" },
    { id: "d1", type: "Date" },
    { id: "d2", type: "Date" },
    { id: "f", type: "Attachments" },
    { id: "w", type: "RefList", options: { refTable: "tasks" } },
    { id: "fx", type: "Choice", is_formula: true },
  ];

  it("start with sensible columns", () => {
    expect(viewDefaults("board", cols, "tasks")).toMatchObject({ boardCol: "s", boardSum: "v", tileTitle: "n", tileCover: "f" });
    expect(viewDefaults("timeline", cols, "tasks")).toMatchObject({ tlStart: "d1", tlEnd: "d2", tlDeps: "w", tlZoom: "week" });
    expect(viewDefaults("timeline", cols, "other").tlDeps).toBeNull();
    expect(viewDefaults("gallery", cols)).toMatchObject({ tileCover: "f", galMode: "records" });
    expect(viewDefaults("board", [{ id: "fx", type: "Choice", is_formula: true }]).boardCol).toBeNull();
  });

  it("knows what a file is", () => {
    expect(fileKind({ mime: "text/csv", file_name: "leads.csv" })).toBe("table");
    expect(fileKind({ mime: "application/octet-stream", file_name: "Report.XLSX" })).toBe("table");
    expect(fileKind({ mime: "image/png", file_name: "a.png" })).toBe("image");
    expect(fileKind({ mime: "application/pdf", file_name: "contract" })).toBe("pdf");
    expect(fileKind({ mime: "application/octet-stream", file_name: "notes.md" })).toBe("text");
    expect(fileKind({ mime: "application/zip", file_name: "a.zip" })).toBe("other");
  });
});

describe("workspace hub", () => {
  const hub = HUB_SPEC;
  const table = (name: string) => hub.tables.find((t) => t.name === name)!;

  it("names only columns and tables that exist", () => {
    for (const t of hub.tables) {
      for (const c of t.columns) {
        if (!c.refTable) continue;
        expect(table(c.refTable), `${t.name}.${c.label} → ${c.refTable}`).toBeTruthy();
        expect(table(c.refTable).columns.some((x) => x.label === c.visibleCol), `${t.name}.${c.label} shows ${c.visibleCol}`).toBe(true);
      }
      for (const row of t.rows) expect(row.length).toBeLessThanOrEqual(t.columns.length);
    }
    for (const p of hub.pages ?? []) {
      p.widgets.forEach((w, i) => {
        const labels = new Set(table(w.table).columns.map((c) => c.label));
        for (const [key, v] of Object.entries(w.options?.labels ?? {})) {
          for (const label of Array.isArray(v) ? v : [v]) expect(labels.has(label as string), `${p.name} / ${w.title}: ${key} = ${label}`).toBe(true);
        }
        if (w.linkCol) expect(labels.has(w.linkCol), `${p.name} / ${w.title}: link by ${w.linkCol}`).toBe(true);
        if (w.linkTo !== undefined) expect(w.linkTo).toBeLessThan(i);
      });
    }
  });

  it("references rows that exist", () => {
    for (const t of hub.tables) {
      t.columns.forEach((c, k) => {
        if (!c.refTable) return;
        const size = table(c.refTable).rows.length;
        for (const row of t.rows) {
          const cell = row[k];
          if (cell && typeof cell === "object" && !Array.isArray(cell)) {
            const ids = "$ref" in cell ? [cell.$ref] : cell.$refs;
            for (const i of ids) expect(i, `${t.name}.${c.label}`).toBeLessThan(size);
          }
        }
      });
    }
  });

  it("makes unique section keys and sensible columns", () => {
    expect(sectionKey("Campaigns", [])).toBe("campaigns");
    expect(sectionKey("Clients", [])).toBe("clients-2");
    expect(sectionKey("Social posts!", ["social-posts"])).toBe("social-posts-2");
    expect(sectionKey("???", [])).toBe("section");
    expect(customSectionColumns("timeline").map((c) => c.label)).toEqual(["Name", "Status", "Owner", "Start", "End", "Files", "Notes"]);
    expect(customSectionColumns("board").map((c) => c.label)).toContain("Date");
  });
});
