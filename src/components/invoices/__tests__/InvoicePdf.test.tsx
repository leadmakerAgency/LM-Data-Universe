// Renders real PDFs (every design, a credit note, a draft, several pages) so a
// broken layout or a library error shows up here and not in front of a client.
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { computeTotals, type Invoice, type Line } from "@/lib/invoices";
import { registerFonts, renderInvoicePdf } from "../InvoicePdf";

beforeAll(() => registerFonts(path.resolve(__dirname, "../../../../public")));

const lines: Line[] = [
  { id: "h", invoice_id: "i", position: 1, kind: "heading", service_id: null, description: "Strategy", quantity: 0, unit: "", unit_price: 0, discount_pct: 0, tax_rate_id: null, tax_rate: 0, tax_category: "S", tax_note: "", net: 0 },
  { id: "a", invoice_id: "i", position: 2, kind: "item", service_id: null, description: "Workshop\nTwo days, on site", quantity: 2, unit: "day", unit_price: 950, discount_pct: 10, tax_rate_id: null, tax_rate: 22, tax_category: "S", tax_note: "", net: 0 },
  { id: "b", invoice_id: "i", position: 3, kind: "item", service_id: null, description: "Consulting (EU client)", quantity: 4.5, unit: "hour", unit_price: 80, discount_pct: 0, tax_rate_id: null, tax_rate: 0, tax_category: "AE", tax_note: "Reverse charge – Art. 196 Council Directive 2006/112/EC", net: 0 },
];
const t = computeTotals(lines, 5);
const priced = lines.map((l) => ({ ...l, net: t.nets.get(l.id) ?? 0 }));

const invoice = {
  id: "i", doc_id: "d", profile_id: "p", kind: "invoice", status: "issued", number: "2026-0007", client_row: 1,
  bill_name: "Acme GmbH", bill_address: "Hauptstraße 1\n10115 Berlin", bill_country: "DE", bill_vat_id: "DE123456789", bill_email: "ap@acme.example",
  issue_date: "2026-11-19", supply_from: "2026-11-01", supply_to: "2026-11-15", due_date: "2026-12-03", reference: "PO-55", currency: "EUR", fx_rate: 1,
  language: "de", template: "classic", color: "#5a43d9", show_qr: true, notes: "Danke!", terms: "Zahlbar innerhalb von 14 Tagen.", discount_pct: 5,
  subtotal: t.subtotal, discount_total: t.discount, tax_total: t.tax, total: t.total, paid_amount: 100, credited_amount: 0, tax_breakdown: t.breakdown,
  seller: { name: "Leadmaker", legal_name: "Leadmaker d.o.o.", address: "Slovenska 1, 1000 Ljubljana", country: "SI", vat_id: "SI12345678", iban: "SI56 1910 0000 0123 438", bic: "BAKOSI2X", email: "billing@leadmaker.example" },
} as unknown as Invoice;

const text = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString("latin1");

describe("invoice PDF", () => {
  it.each(["classic", "modern", "minimal", "bold"] as const)("renders the %s design", async (template) => {
    const pdf = await renderInvoicePdf({ invoice: { ...invoice, template }, lines: priced, seller: invoice.seller });
    const s = await text(pdf);
    // INVOICE_PDF_OUT=<folder> keeps the files for a look.
    if (process.env.INVOICE_PDF_OUT) (await import("node:fs")).writeFileSync(path.join(process.env.INVOICE_PDF_OUT, `${template}.pdf`), Buffer.from(await pdf.arrayBuffer()));
    expect(s.startsWith("%PDF-")).toBe(true);
    expect(pdf.size).toBeGreaterThan(5_000);
  }, 30_000);

  it("renders drafts, credit notes and long invoices over several pages", async () => {
    const many = Array.from({ length: 70 }, (_, k) => ({ ...priced[1], id: `x${k}`, description: `Line ${k + 1}` }));
    const long = await renderInvoicePdf({ invoice: { ...invoice, language: "sl" }, lines: many, seller: invoice.seller, draft: true });
    const pages = (await text(long)).match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    if (process.env.INVOICE_PDF_OUT) (await import("node:fs")).writeFileSync(path.join(process.env.INVOICE_PDF_OUT, "long.pdf"), Buffer.from(await long.arrayBuffer()));
    const credit = await renderInvoicePdf({ invoice: { ...invoice, kind: "credit_note", number: "CN-2026-0001", total: -t.total }, lines: priced.map((l) => ({ ...l, quantity: -l.quantity })), seller: invoice.seller, creditFor: "2026-0007" });
    expect(credit.size).toBeGreaterThan(5_000);
  }, 60_000);
});
