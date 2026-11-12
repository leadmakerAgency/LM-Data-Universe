import { describe, expect, it } from "vitest";
import { autoMap, googleSheetsExportUrl, planImport, readSheets, sheetFromGrid } from "../importer";
import { isPrivateAddress } from "../urlImport";
import type { CellValue, DocColumn } from "../types";

const col = (id: string, type: DocColumn["type"], label = id): DocColumn => ({
  id,
  doc_id: "d",
  table_ref: "t",
  col_id: label.replace(/\s/g, "_"),
  label,
  type,
  is_formula: false,
  formula: "",
  options: {},
  position: 0,
});
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("reading files", () => {
  it("CSV with a BOM, blank lines and duplicate headers", async () => {
    const [s] = await readSheets("people.csv", "text/csv", enc("﻿Name,Name,Age\n\nAnn,A,30\nBob,,41\n"));
    expect(s.name).toBe("people");
    expect(s.header).toEqual(["Name", "Name 2", "Age"]);
    expect(s.rows).toEqual([
      ["Ann", "A", "30"],
      ["Bob", "", "41"],
    ]);
  });

  it("TSV", async () => {
    const [s] = await readSheets("x.tsv", "", enc("a\tb\n1\t2\n"));
    expect(s.rows).toEqual([["1", "2"]]);
  });

  it("refuses web pages", async () => {
    await expect(readSheets("export", "text/html", enc("<!DOCTYPE html><html></html>"))).rejects.toThrow(/web page/);
  });

  it("pads short rows", () => {
    expect(sheetFromGrid("t", [["a", "b"], ["1"]]).rows).toEqual([["1", ""]]);
  });
});

describe("Google Sheets links", () => {
  it("become an Excel export of the whole spreadsheet", () => {
    expect(googleSheetsExportUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0")).toBe(
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=xlsx",
    );
    expect(googleSheetsExportUrl("https://example.com/data.csv")).toBeNull();
  });
  it("published CSV links are kept", () => {
    const u = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRabcdefghijklmnopqrstuvwxyz/pub?output=csv";
    expect(googleSheetsExportUrl(u)).toBe(u);
  });
});

describe("private addresses", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "172.32.0.1", "142.250.185.14", "2a00:1450:4001:80b::200e"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("planning an import", () => {
  const email = col("e", "Text", "Email");
  const name = col("n", "Text", "Name");
  const age = col("a", "Int", "Age");
  const vip = col("v", "Bool", "VIP");
  const existing = new Map<number, Record<string, CellValue>>([
    [1, { e: "ann@x.com", n: "Ann", a: 30 }],
    [2, { e: "bob@x.com", n: "Bob", a: 40, v: true }],
  ]);
  const sheet = sheetFromGrid("s", [
    ["email", "name", "age", "vip"],
    ["ANN@x.com ", "Ann", "31", ""],
    ["bob@x.com", "Bob", "40", "yes"],
    ["cy@x.com", "Cy", "22", "no"],
    ["", "Nobody", "1", ""],
  ]);

  it("maps columns by name", () => {
    expect(autoMap(sheet.header, [email, name, age, vip])).toEqual(["e", "n", "a", "v"]);
  });

  it("adds everything", () => {
    const p = planImport(sheet, { mapping: [email, name, age, vip], keys: [], mode: "add" }, existing);
    expect(p.adds).toHaveLength(4);
    expect(p.adds[2]).toEqual({ e: "cy@x.com", n: "Cy", a: 22 });
  });

  it("updates matches by key (ignoring case and spaces) and adds the rest", () => {
    const p = planImport(sheet, { mapping: [email, name, age, vip], keys: ["e"], mode: "upsert" }, existing);
    expect(p.updates).toEqual([{ id: 1, values: { e: "ANN@x.com", a: 31 } }]);
    expect(p.unchanged).toBe(1);
    expect(p.adds.map((r) => r.n)).toEqual(["Cy"]);
    expect(p.skipped).toBe(1);
  });

  it("only updates when asked", () => {
    const p = planImport(sheet, { mapping: [email, null, age, null], keys: ["e"], mode: "update" }, existing);
    expect(p.adds).toHaveLength(0);
    expect(p.updates).toHaveLength(1);
    expect(p.skipped).toBe(2);
  });

  it("counts ambiguous keys", () => {
    const dup = new Map(existing);
    dup.set(3, { e: "ann@x.com" });
    expect(planImport(sheet, { mapping: [email, name, age, vip], keys: ["e"], mode: "upsert" }, dup).ambiguous).toBe(1);
  });
});
