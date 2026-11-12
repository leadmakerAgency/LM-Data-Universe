import { describe, expect, it } from "vitest";
import { ApiError, docId, flag, parseFilter, parseLimit, recordList, tableName } from "../apiServer";

const url = (q: string) => new URL(`https://x.test/api?${q}`);

describe("REST API request parsing", () => {
  it("accepts JSON object filters only", () => {
    expect(parseFilter(url(`filter=${encodeURIComponent('{"Status":["Done"]}')}`))).toEqual({ Status: ["Done"] });
    expect(parseFilter(url(""))).toBeNull();
    expect(() => parseFilter(url("filter=[1]"))).toThrow(ApiError);
    expect(() => parseFilter(url("filter=nope"))).toThrow(ApiError);
  });

  it("limits are whole numbers; 0 means no limit", () => {
    expect(parseLimit(url("limit=25"))).toBe(25);
    expect(parseLimit(url("limit=0"))).toBeNull();
    expect(() => parseLimit(url("limit=-1"))).toThrow(ApiError);
    expect(() => parseLimit(url("limit=2.5"))).toThrow(ApiError);
  });

  it("record lists come wrapped or bare", () => {
    expect(recordList({ records: [{ fields: {} }] })).toHaveLength(1);
    expect(recordList([{ id: 1 }])).toHaveLength(1);
    expect(() => recordList({ fields: {} })).toThrow(ApiError);
  });

  it("flags", () => {
    expect(flag(url("noadd"), "noadd")).toBe(true);
    expect(flag(url("noadd=1"), "noadd")).toBe(true);
    expect(flag(url("noadd=false"), "noadd")).toBe(false);
    expect(flag(url(""), "noadd")).toBe(false);
  });

  it("document ids must be uuids; table names decode safely", () => {
    expect(() => docId("../etc")).toThrow(ApiError);
    expect(docId("6e83ef56-eebd-4458-9c07-83ce1cc694e3")).toBe("6e83ef56-eebd-4458-9c07-83ce1cc694e3");
    expect(tableName("My%20Table")).toBe("My Table");
    expect(tableName("100%")).toBe("100%");
  });
});
