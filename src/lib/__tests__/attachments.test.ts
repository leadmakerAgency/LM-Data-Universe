import { describe, expect, it } from "vitest";
import { attachmentIds, formatBytes, isAttachmentId } from "../attachments";
import { convertValue, isInvalid, parseInput, type DisplayContext, type ParseContext } from "../format";
import type { DocColumn } from "../types";

const col = (type: DocColumn["type"]): DocColumn => ({
  id: "c1", doc_id: "d", table_ref: "t", col_id: "Files", label: "Files", type,
  is_formula: false, formula: "", options: {}, position: 1,
});
const A = "0b6f1c7e-2a8b-4d1e-9f3a-5c7d9e1f2a3b";
const B = "1c7f2d8e-3b9c-4e2f-8a4b-6d8e0f2a3b4c";

describe("attachment values", () => {
  it("recognises attachment ids", () => {
    expect(isAttachmentId(A)).toBe(true);
    expect(isAttachmentId("not-an-id")).toBe(false);
    expect(attachmentIds([A, 3, "x", B])).toEqual([A, B]);
    expect(attachmentIds("x")).toEqual([]);
  });

  it("parses pasted ids and rejects other text", () => {
    expect(parseInput(col("Attachments"), `${A}, ${B}`)).toEqual([A, B]);
    expect(parseInput(col("Attachments"), "report.pdf")).toBe("report.pdf");
    expect(parseInput(col("Attachments"), "")).toBeNull();
  });

  it("flags values that aren't lists of ids", () => {
    expect(isInvalid(col("Attachments"), [A])).toBe(false);
    expect(isInvalid(col("Attachments"), "report.pdf")).toBe(true);
    expect(isInvalid(col("Attachments"), ["report.pdf"])).toBe(true);
  });

  it("keeps ids when converting to Attachments and drops anything else", () => {
    const ctx = {} as DisplayContext & ParseContext;
    expect(convertValue([A], col("Any"), col("Attachments"), ctx, [A])).toEqual([A]);
    expect(convertValue("hello", col("Text"), col("Attachments"), ctx, "hello")).toBeNull();
  });

  it("formats file sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
