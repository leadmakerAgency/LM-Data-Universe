import { afterEach, describe, expect, it } from "vitest";
import { formatDate, formatNumber, normalizeNumber, parseDateTimeText, parseInput, setFormatSettings } from "../format";
import type { DocColumn } from "../types";

const col = (type: DocColumn["type"], options: DocColumn["options"] = {}): DocColumn => ({
  id: "c",
  doc_id: "d",
  table_ref: "t",
  col_id: "C",
  label: "C",
  type,
  is_formula: false,
  formula: "",
  options,
  position: 0,
});

afterEach(() => setFormatSettings({}));

describe("document settings in formatting", () => {
  it("formats numbers and currencies in the document's locale", () => {
    setFormatSettings({ locale: "de-DE", currency: "EUR" });
    expect(formatNumber(1234.5, col("Numeric", { numMode: "currency" }))).toMatch(/^1\.234,50\s€$/);
    expect(formatNumber(1234.5, col("Numeric", { numMode: "currency", currency: "USD" }))).toMatch(/\$/);
    expect(formatNumber(0.25, col("Numeric", { numMode: "percent" }))).toBe("25%");
    setFormatSettings({ locale: "en-US" });
    expect(formatNumber(1234.5, col("Numeric", { numMode: "currency" }))).toBe("$1,234.50");
  });

  it("reads typed numbers the locale's way", () => {
    setFormatSettings({ locale: "nl-NL" });
    expect(normalizeNumber("1.234,5")).toBe("1234.5");
    expect(normalizeNumber("1.234")).toBe("1234");
    expect(normalizeNumber("1.5")).toBe("1.5");
    expect(parseInput(col("Numeric"), "€ 1.234,50")).toBe(1234.5);
    expect(parseInput(col("Numeric"), "12,5%")).toBe(0.125);
    setFormatSettings({ locale: "en-US" });
    expect(parseInput(col("Numeric"), "$1,234.50")).toBe(1234.5);
    expect(parseInput(col("Int"), "1,234")).toBe(1234);
    expect(parseInput(col("Numeric"), "abc")).toBe("abc");
  });

  it("shows month names in the locale", () => {
    setFormatSettings({ locale: "nl-NL" });
    expect(formatDate(new Date("2026-03-05T00:00:00Z"), "D MMMM YYYY")).toBe("5 maart 2026");
    setFormatSettings({});
    expect(formatDate(new Date("2026-03-05T00:00:00Z"), "MMM D, YYYY")).toBe("Mar 5, 2026");
  });

  it("shows and reads DateTime values in the document's time zone", () => {
    setFormatSettings({ timezone: "Europe/Amsterdam" });
    const t = new Date("2026-07-01T22:30:00Z");
    expect(formatDate(t, "YYYY-MM-DD", true)).toBe("2026-07-02 00:30");
    expect(parseDateTimeText("2026-07-02 00:30")).toBe("2026-07-01T22:30:00.000Z");
    expect(parseDateTimeText("02/07/2026 9:15 pm", "DD/MM/YYYY")).toBe("2026-07-02T19:15:00.000Z");
    expect(parseDateTimeText("2026-07-02T00:30:00Z")).toBe("2026-07-02T00:30:00.000Z");
    expect(parseInput(col("DateTime"), "2026-01-10 08:00")).toBe("2026-01-10T07:00:00.000Z");
    setFormatSettings({ timezone: "America/New_York" });
    expect(formatDate(t, "YYYY-MM-DD", true)).toBe("2026-07-01 18:30");
    expect(parseDateTimeText("not a date")).toBeNull();
  });

  it("falls back quietly for settings it can't use", () => {
    setFormatSettings({ locale: "xx-INVALID-zzzzzzzzzzz", timezone: "Mars/Olympus" });
    expect(formatNumber(2, col("Numeric"))).toBe("2");
    expect(formatDate(new Date("2026-07-01T22:30:00Z"), "YYYY-MM-DD", true)).toMatch(/^2026-07-0[12] \d\d:30$/);
  });
});
