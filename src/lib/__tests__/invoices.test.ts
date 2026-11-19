// The invoice totals must equal the database's (supabase/tests/workspace_invoices.sql
// uses the same lines), plus numbering, QR text and the e-invoice.
import { describe, expect, it } from "vitest";
import { balanceOf, computeTotals, displayStatus, epcQrText, formatNumber, round2, ublXml, type Invoice, type Line } from "../invoices";

const line = (id: string, quantity: number, unit_price: number, discount_pct: number, tax_rate: number, tax_category: Line["tax_category"] = "S", tax_note = "") =>
  ({ id, kind: "item" as const, quantity, unit_price, discount_pct, tax_rate, tax_category, tax_note });

describe("totals", () => {
  it("match the database for the shared fixture", () => {
    const t = computeTotals([line("a", 3, 33.3333, 0, 22), line("b", 2.5, 80, 10, 22), { ...line("h", 0, 0, 0, 0), kind: "heading" as const }, line("c", 1, 50, 0, 9.5)], 5);
    expect(t.subtotal).toBe(330);
    expect(t.discount).toBe(16.5);
    expect(t.tax).toBe(63.03);
    expect(t.total).toBe(376.53);
    expect(t.breakdown).toEqual([
      { rate: 22, category: "S", note: "", base: 266, tax: 58.52 },
      { rate: 9.5, category: "S", note: "", base: 47.5, tax: 4.51 },
    ]);
    expect(t.nets.get("a")).toBe(100);
    expect(t.nets.has("h")).toBe(false);
  });

  it("handle credit notes, reverse charge and rounding halves", () => {
    expect(computeTotals([line("a", -1, 100, 0, 22)], 0).total).toBe(-122);
    const rc = computeTotals([line("a", 1, 500, 0, 0, "AE", "Reverse charge")], 0);
    expect(rc.breakdown).toEqual([{ rate: 0, category: "AE", note: "Reverse charge", base: 500, tax: 0 }]);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(-0.125)).toBe(-0.13);
    expect(round2(1.005)).toBe(1.01);
  });

  it("show the right status and balance", () => {
    const base = { kind: "invoice" as const, status: "issued" as const, sent_at: null, viewed_at: null, due_date: "2099-01-01", paid_amount: 0, credited_amount: 0, total: 100 };
    expect(displayStatus(base).label).toBe("Issued");
    expect(displayStatus({ ...base, sent_at: "x" }).label).toBe("Sent");
    expect(displayStatus({ ...base, paid_amount: 40 }).label).toBe("Partly paid");
    expect(displayStatus({ ...base, due_date: "2000-01-01" }).label).toBe("Overdue");
    expect(displayStatus({ ...base, status: "paid", credited_amount: 100 }).label).toBe("Credited");
    expect(balanceOf({ total: 100, paid_amount: 40, credited_amount: 10 })).toBe(50);
  });
});

describe("numbers, QR and e-invoice", () => {
  it("format number patterns like the database", () => {
    expect(formatNumber("{YYYY}-{####}", 42, "2026-03-10")).toBe("2026-0042");
    expect(formatNumber("INV-{YY}{MM}-{###}", 7, "2026-03-10")).toBe("INV-2603-007");
    expect(formatNumber("R###", 12345, "2026-01-01")).toBe("R12345");
  });

  it("make a SEPA QR text only for EUR with an IBAN", () => {
    const t = epcQrText({ name: "Agency d.o.o.", iban: "SI56 1910 0000 0123 438", bic: "BAKOSI2X", amount: 376.53, currency: "EUR", reference: "2026-0001" })!;
    expect(t.split("\n")).toEqual(["BCD", "002", "1", "SCT", "BAKOSI2X", "Agency d.o.o.", "SI56191000000123438", "EUR376.53", "", "", "2026-0001"]);
    expect(epcQrText({ name: "A", iban: "SI56191000000123438", amount: 10, currency: "USD", reference: "x" })).toBeNull();
    expect(epcQrText({ name: "A", iban: "", amount: 10, currency: "EUR", reference: "x" })).toBeNull();
  });

  it("write a UBL invoice with totals, tax per rate and escaped text", () => {
    const inv = {
      kind: "invoice", number: "2026-0001", issue_date: "2026-03-10", due_date: "2026-04-09", currency: "EUR", notes: "Thanks <3", reference: "", supply_from: null, supply_to: null,
      bill_name: "Acme & Co", bill_address: "Elm street 5, London", bill_country: "GB", bill_vat_id: "", bill_email: "a@b.c",
      subtotal: 330, discount_total: 16.5, discount_pct: 5, tax_total: 63.03, total: 376.53,
      tax_breakdown: [{ rate: 22, category: "S", note: null, base: 266, tax: 58.52 }, { rate: 9.5, category: "S", note: null, base: 47.5, tax: 4.51 }],
      seller: { name: "Agency", legal_name: "Agency d.o.o.", address: "Main 1, Ljubljana", country: "SI", vat_id: "SI12345678", iban: "SI56 1910 0000 0123 438" },
    } as unknown as Invoice;
    const xml = ublXml(inv, [{ id: "a", kind: "item", description: "Strategy", quantity: 3, unit_price: 33.3333, discount_pct: 0, tax_rate: 22, tax_category: "S", net: 100 } as Line]);
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">376.53</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="EUR">63.03</cbc:TaxAmount>');
    expect(xml).toContain("Acme &amp; Co");
    expect(xml).toContain("Thanks &lt;3");
    expect(xml).toContain("<cbc:ID>SI56191000000123438</cbc:ID>");
  });
});
