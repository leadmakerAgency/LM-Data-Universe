import { describe, expect, it } from "vitest";
import { safeNext } from "../safeNext";

describe("safeNext", () => {
  it("keeps in-app paths", () => {
    expect(safeNext("/doc/abc?x=1#y")).toBe("/doc/abc?x=1#y");
    expect(safeNext("/admin")).toBe("/admin");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("refuses anything that leaves the site", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "\\\\evil.com", "javascript:alert(1)", "/\t/evil.com", "evil.com"]) {
      expect(safeNext(bad), bad).toBe("/");
    }
  });
});
