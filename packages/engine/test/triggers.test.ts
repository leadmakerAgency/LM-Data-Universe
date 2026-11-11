import { describe, expect, it } from "vitest";
import { applyTriggers } from "../src/triggers";
import { col, fixture } from "./fixture";

const user = { Email: "ada@example.com", Name: "Ada", UserID: "u1", Access: "owner" };

describe("trigger formulas", () => {
  const created = { ...col("oBy", "to", "CreatedBy", "Text"), formula: "user.Email", options: { trigger: { onNew: true } } };
  const touched = { ...col("oTouched", "to", "Touched", "Numeric"), formula: "$Amount * 2", options: { trigger: { onChange: ["oAmt"] } } };
  const anyChange = { ...col("oAny", "to", "AnyChange", "Text"), formula: '"changed"', options: { trigger: { onChange: "any" as const } } };
  const data = fixture([created, touched, anyChange]);

  it("fills new records, using the user and the record's own values", () => {
    const [a] = applyTriggers(data, [{ op: "AddRecords", table: "to", records: [{ data: { oAmt: 5 } }] }], user);
    expect((a as { records: { data: Record<string, unknown> }[] }).records[0].data).toEqual({ oAmt: 5, oBy: "ada@example.com" });
  });

  it("keeps an explicitly given value", () => {
    const [a] = applyTriggers(data, [{ op: "AddRecords", table: "to", records: [{ data: { oBy: "given" } }] }], user);
    expect((a as { records: { data: Record<string, unknown> }[] }).records[0].data.oBy).toBe("given");
  });

  it("recomputes on changes to watched columns only", () => {
    const [a] = applyTriggers(data, [{ op: "UpdateRecords", table: "to", records: [{ id: 10, values: { oAmt: 7 } }] }], user);
    expect((a as { records: { values: Record<string, unknown> }[] }).records[0].values).toEqual({ oAmt: 7, oTouched: 14, oAny: "changed" });
    const [b] = applyTriggers(data, [{ op: "UpdateRecords", table: "to", records: [{ id: 10, values: { oDate: "2026-01-01" } }] }], user);
    expect((b as { records: { values: Record<string, unknown> }[] }).records[0].values).toEqual({ oDate: "2026-01-01", oAny: "changed" });
  });

  it("leaves other actions and documents without triggers alone", () => {
    const plain = fixture();
    const actions = [{ op: "UpdateRecords", table: "to", records: [{ id: 10, values: { oAmt: 1 } }] }];
    expect(applyTriggers(plain, actions)).toBe(actions);
  });
});

describe("trigger formulas on the server", () => {
  it("fills records added by a form", async () => {
    const { triggerUpdatesForApplied } = await import("../src/triggers");
    const stamp = { ...col("oStamp", "to", "Stamp", "Text"), formula: '"from " + str($Amount)', options: { trigger: { onNew: true } } };
    const data = fixture([stamp]);
    const out = triggerUpdatesForApplied(data, [[{ op: "AddRecords", table: "to", records: [{ id: 12, data: { oCust: 2, oAmt: 15 } }] }]]);
    expect(out).toEqual([{ op: "UpdateRecords", table: "to", records: [{ id: 12, values: { oStamp: "from 15" } }] }]);
  });
});
