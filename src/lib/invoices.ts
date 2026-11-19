// Invoices: types, the totals engine (the same algorithm as the database's
// _invoice_totals), number patterns, labels in several languages, the SEPA
// payment QR text and the EN 16931 / Peppol UBL e-invoice.

export type InvoiceKind = "invoice" | "credit_note" | "quote" | "proforma";
export type InvoiceStatus = "draft" | "issued" | "paid" | "void" | "accepted" | "declined";
export type TaxCategory = "S" | "Z" | "E" | "AE" | "K" | "G" | "O";
export type Template = "classic" | "modern" | "minimal" | "bold";

export interface Profile {
  id: string;
  doc_id: string;
  name: string;
  legal_name: string;
  address: string;
  country: string;
  vat_id: string;
  reg_no: string;
  email: string;
  phone: string;
  website: string;
  iban: string;
  bic: string;
  bank_name: string;
  logo_url: string;
  color: string;
  template: Template;
  language: string;
  currency: string;
  terms_days: number;
  vat_registered: boolean;
  notes: string;
  terms: string;
  footer: string;
  show_qr: boolean;
  reminders_on: boolean;
  reminder_days: number[];
  email_subject: string;
  email_body: string;
  reminder_subject: string;
  reminder_body: string;
  is_default: boolean;
}

export interface TaxRate {
  id: string;
  name: string;
  rate: number;
  category: TaxCategory;
  note: string;
  is_default: boolean;
  position: number;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  unit: string;
  price: number;
  tax_rate_id: string | null;
  active: boolean;
}

export interface Series {
  id: string;
  profile_id: string;
  kind: InvoiceKind;
  pattern: string;
  next_number: number;
  yearly: boolean;
  year: number | null;
}

export interface Line {
  id: string;
  invoice_id: string;
  position: number;
  kind: "item" | "heading";
  service_id: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_pct: number;
  tax_rate_id: string | null;
  tax_rate: number;
  tax_category: TaxCategory;
  tax_note: string;
  net: number;
}

export interface Seller {
  name: string;
  legal_name: string;
  address: string;
  country: string;
  vat_id: string;
  reg_no: string;
  email: string;
  phone: string;
  website: string;
  iban: string;
  bic: string;
  bank_name: string;
  logo_url: string;
  footer: string;
  vat_registered: boolean;
}

export interface Invoice {
  id: string;
  doc_id: string;
  profile_id: string | null;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  client_row: number | null;
  bill_name: string;
  bill_address: string;
  bill_country: string;
  bill_vat_id: string;
  bill_email: string;
  issue_date: string;
  supply_from: string | null;
  supply_to: string | null;
  due_date: string | null;
  reference: string;
  currency: string;
  fx_rate: number;
  language: string;
  template: Template;
  color: string;
  show_qr: boolean;
  notes: string;
  terms: string;
  discount_pct: number;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  paid_amount: number;
  credited_amount: number;
  tax_breakdown: { rate: number; category: TaxCategory; note: string | null; base: number; tax: number }[];
  seller: Partial<Seller>;
  public_token: string | null;
  pdf_path: string | null;
  xml_path: string | null;
  issued_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  credit_of: string | null;
  quote_of: string | null;
  recurring_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- totals

/** Rounds to 2 decimals, half away from zero, like the database's round(numeric). */
export function round2(x: number): number {
  const s = Math.sign(x);
  return (s * Math.round(Math.abs(x) * 100 + 1e-7)) / 100 || 0;
}

export interface Totals {
  nets: Map<string, number>;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  breakdown: { rate: number; category: TaxCategory; note: string; base: number; tax: number }[];
}

/** The invoice's totals; the same algorithm as public._invoice_totals (see the migration). */
export function computeTotals(lines: Pick<Line, "id" | "kind" | "quantity" | "unit_price" | "discount_pct" | "tax_rate" | "tax_category" | "tax_note">[], discountPct: number): Totals {
  const nets = new Map<string, number>();
  const groups = new Map<string, { rate: number; category: TaxCategory; note: string; sum: number }>();
  let subtotal = 0;
  for (const l of lines) {
    if (l.kind !== "item") continue;
    const net = round2(Number(l.quantity) * Number(l.unit_price) * (1 - Number(l.discount_pct) / 100));
    nets.set(l.id, net);
    subtotal += net;
    const key = `${Number(l.tax_rate)}|${l.tax_category}`;
    const g = groups.get(key) ?? { rate: Number(l.tax_rate), category: l.tax_category, note: "", sum: 0 };
    g.sum += net;
    if (l.tax_note && l.tax_note > g.note) g.note = l.tax_note;
    groups.set(key, g);
  }
  subtotal = round2(subtotal);
  const breakdown = [...groups.values()]
    .map((g) => {
      const base = round2(g.sum * (1 - Number(discountPct) / 100));
      return { rate: g.rate, category: g.category, note: g.note, base, tax: round2((base * g.rate) / 100) };
    })
    .sort((a, b) => b.rate - a.rate || a.category.localeCompare(b.category));
  const bases = round2(breakdown.reduce((n, b) => n + b.base, 0));
  const tax = round2(breakdown.reduce((n, b) => n + b.tax, 0));
  return { nets, subtotal, discount: round2(subtotal - bases), tax, total: round2(bases + tax), breakdown };
}

export const balanceOf = (i: Pick<Invoice, "total" | "paid_amount" | "credited_amount">) => round2(Number(i.total) - Number(i.paid_amount) - Number(i.credited_amount));

/** The status people see: Draft, Issued, Sent, Viewed, Partly paid, Paid, Overdue, Void, Credited, Accepted, Declined. */
export function displayStatus(i: Pick<Invoice, "kind" | "status" | "sent_at" | "viewed_at" | "due_date" | "paid_amount" | "credited_amount" | "total">, today = new Date()): { label: string; tone: "gray" | "blue" | "amber" | "green" | "red" } {
  if (i.status === "draft") return { label: "Draft", tone: "gray" };
  if (i.status === "void") return { label: "Void", tone: "gray" };
  if (i.status === "accepted") return { label: "Accepted", tone: "green" };
  if (i.status === "declined") return { label: "Declined", tone: "red" };
  if (i.kind === "credit_note") return { label: "Issued", tone: "blue" };
  if (i.status === "paid") return { label: Number(i.credited_amount) >= Number(i.total) && Number(i.total) > 0 ? "Credited" : "Paid", tone: "green" };
  const iso = today.toISOString().slice(0, 10);
  if (i.kind === "invoice" && i.due_date && i.due_date < iso) return { label: "Overdue", tone: "red" };
  if (Number(i.paid_amount) > 0) return { label: "Partly paid", tone: "amber" };
  if (i.viewed_at) return { label: "Viewed", tone: "blue" };
  if (i.sent_at) return { label: "Sent", tone: "blue" };
  return { label: "Issued", tone: "blue" };
}

// ---------------------------------------------------------------- numbers and money

/** "{YYYY}-{####}" → "2026-0042" (the same as public._invoice_number). */
export function formatNumber(pattern: string, n: number, date: Date | string): string {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00Z`) : date;
  const y = String(d.getUTCFullYear());
  let v = pattern.replace(/\{YYYY\}/g, y).replace(/\{YY\}/g, y.slice(2)).replace(/\{MM\}/g, String(d.getUTCMonth() + 1).padStart(2, "0"));
  const braced = /\{(#+)\}/.exec(v);
  if (braced) return v.replace(braced[0], String(n).padStart(braced[1].length, "0"));
  const bare = /#+/.exec(v);
  if (bare) v = v.replace(/#+/g, String(n).padStart(bare[0].length, "0"));
  return v;
}

export function money(n: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale || undefined, { style: "currency", currency }).format(Number(n) || 0);
  } catch {
    return `${currency} ${(Number(n) || 0).toFixed(2)}`;
  }
}

export function qty(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 4 }).format(Number(n) || 0);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const EU = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];

export const CATEGORY_LABEL: Record<TaxCategory, string> = {
  S: "Standard rate",
  Z: "Zero rated",
  E: "Exempt",
  AE: "Reverse charge",
  K: "Intra-EU supply",
  G: "Export outside the EU",
  O: "Outside the scope of VAT",
};

/** A starting set of tax rates for a country (the standard and reduced VAT rates as of 2026, plus the no-VAT cases). */
export function defaultTaxRates(country: string): Omit<TaxRate, "id" | "position">[] {
  const std: Record<string, number[]> = {
    SI: [22, 9.5, 5], HR: [25, 13, 5], DE: [19, 7], AT: [20, 10, 13], IT: [22, 10, 5, 4], FR: [20, 10, 5.5], ES: [21, 10, 4], NL: [21, 9], BE: [21, 12, 6],
    PL: [23, 8, 5], CZ: [21, 12], SK: [23, 19, 5], HU: [27, 18, 5], RO: [21, 11], BG: [20, 9], IE: [23, 13.5, 9], PT: [23, 13, 6], GR: [24, 13, 6], DK: [25], SE: [25, 12, 6], FI: [25.5, 14, 10],
    LU: [17, 14, 8], EE: [24, 9], LV: [21, 12, 5], LT: [21, 9, 5], CY: [19, 9, 5], MT: [18, 7, 5], GB: [20, 5], CH: [8.1, 2.6], RS: [20, 10], BA: [17], US: [0],
  };
  const rates = std[country] ?? [20];
  return [
    ...rates.map((r, i) => ({ name: `${i === 0 ? "Standard" : "Reduced"} ${r}%`, rate: r, category: "S" as const, note: "", is_default: i === 0 })),
    { name: "Reverse charge (EU business)", rate: 0, category: "AE", note: "Reverse charge – Article 196 of Directive 2006/112/EC", is_default: false },
    { name: "Export outside the EU", rate: 0, category: "G", note: "VAT exempt export of services outside the EU", is_default: false },
    { name: "Not subject to VAT", rate: 0, category: "O", note: "Not subject to VAT", is_default: false },
  ];
}

// ---------------------------------------------------------------- labels

type Labels = Record<"invoice" | "credit_note" | "quote" | "proforma" | "number" | "issue_date" | "due_date" | "supply" | "reference" | "bill_to" | "description" | "quantity" | "unit" | "price" | "discount" | "vat" | "amount" | "subtotal" | "total" | "paid" | "balance" | "vat_id" | "reg_no" | "bank" | "notes" | "terms" | "credit_for" | "scan_to_pay" | "page", string>;

export const LABELS: Record<string, Labels> = {
  en: { invoice: "Invoice", credit_note: "Credit note", quote: "Quote", proforma: "Pro forma invoice", number: "Number", issue_date: "Date of issue", due_date: "Due date", supply: "Date of supply", reference: "Reference", bill_to: "Bill to", description: "Description", quantity: "Qty", unit: "Unit", price: "Unit price", discount: "Discount", vat: "VAT", amount: "Amount", subtotal: "Subtotal", total: "Total", paid: "Paid", balance: "Balance due", vat_id: "VAT ID", reg_no: "Reg. no.", bank: "Bank details", notes: "Notes", terms: "Terms", credit_for: "Credit for invoice", scan_to_pay: "Scan to pay", page: "Page" },
  sl: { invoice: "Račun", credit_note: "Dobropis", quote: "Ponudba", proforma: "Predračun", number: "Številka", issue_date: "Datum izdaje", due_date: "Rok plačila", supply: "Datum opravljene storitve", reference: "Sklic", bill_to: "Kupec", description: "Opis", quantity: "Kol.", unit: "EM", price: "Cena", discount: "Popust", vat: "DDV", amount: "Znesek", subtotal: "Skupaj brez DDV", total: "Za plačilo", paid: "Plačano", balance: "Ostane za plačilo", vat_id: "ID za DDV", reg_no: "Matična št.", bank: "Podatki za plačilo", notes: "Opombe", terms: "Pogoji", credit_for: "Dobropis za račun", scan_to_pay: "Skeniraj za plačilo", page: "Stran" },
  hr: { invoice: "Račun", credit_note: "Odobrenje", quote: "Ponuda", proforma: "Predračun", number: "Broj", issue_date: "Datum izdavanja", due_date: "Rok plaćanja", supply: "Datum isporuke", reference: "Poziv na broj", bill_to: "Kupac", description: "Opis", quantity: "Kol.", unit: "JM", price: "Cijena", discount: "Popust", vat: "PDV", amount: "Iznos", subtotal: "Osnovica", total: "Ukupno", paid: "Plaćeno", balance: "Preostalo za platiti", vat_id: "OIB / PDV ID", reg_no: "MBS", bank: "Podaci za plaćanje", notes: "Napomene", terms: "Uvjeti", credit_for: "Odobrenje za račun", scan_to_pay: "Skeniraj za plaćanje", page: "Stranica" },
  de: { invoice: "Rechnung", credit_note: "Gutschrift", quote: "Angebot", proforma: "Proformarechnung", number: "Nummer", issue_date: "Rechnungsdatum", due_date: "Fällig am", supply: "Leistungsdatum", reference: "Referenz", bill_to: "Rechnungsempfänger", description: "Beschreibung", quantity: "Menge", unit: "Einheit", price: "Einzelpreis", discount: "Rabatt", vat: "USt.", amount: "Betrag", subtotal: "Zwischensumme", total: "Gesamt", paid: "Bezahlt", balance: "Offener Betrag", vat_id: "USt-IdNr.", reg_no: "Handelsreg.", bank: "Bankverbindung", notes: "Hinweise", terms: "Bedingungen", credit_for: "Gutschrift zu Rechnung", scan_to_pay: "Zum Bezahlen scannen", page: "Seite" },
  it: { invoice: "Fattura", credit_note: "Nota di credito", quote: "Preventivo", proforma: "Fattura proforma", number: "Numero", issue_date: "Data", due_date: "Scadenza", supply: "Data della prestazione", reference: "Riferimento", bill_to: "Cliente", description: "Descrizione", quantity: "Qtà", unit: "U.M.", price: "Prezzo", discount: "Sconto", vat: "IVA", amount: "Importo", subtotal: "Imponibile", total: "Totale", paid: "Pagato", balance: "Da pagare", vat_id: "P. IVA", reg_no: "Reg. imprese", bank: "Coordinate bancarie", notes: "Note", terms: "Condizioni", credit_for: "Nota di credito per fattura", scan_to_pay: "Scansiona per pagare", page: "Pagina" },
  es: { invoice: "Factura", credit_note: "Factura rectificativa", quote: "Presupuesto", proforma: "Factura proforma", number: "Número", issue_date: "Fecha de emisión", due_date: "Vencimiento", supply: "Fecha de prestación", reference: "Referencia", bill_to: "Cliente", description: "Descripción", quantity: "Cant.", unit: "Unidad", price: "Precio", discount: "Descuento", vat: "IVA", amount: "Importe", subtotal: "Base imponible", total: "Total", paid: "Pagado", balance: "Pendiente", vat_id: "NIF-IVA", reg_no: "Reg. mercantil", bank: "Datos bancarios", notes: "Notas", terms: "Condiciones", credit_for: "Rectifica la factura", scan_to_pay: "Escanea para pagar", page: "Página" },
  fr: { invoice: "Facture", credit_note: "Avoir", quote: "Devis", proforma: "Facture proforma", number: "Numéro", issue_date: "Date", due_date: "Échéance", supply: "Date de prestation", reference: "Référence", bill_to: "Client", description: "Description", quantity: "Qté", unit: "Unité", price: "Prix unitaire", discount: "Remise", vat: "TVA", amount: "Montant", subtotal: "Total HT", total: "Total TTC", paid: "Payé", balance: "Reste à payer", vat_id: "N° TVA", reg_no: "SIRET", bank: "Coordonnées bancaires", notes: "Notes", terms: "Conditions", credit_for: "Avoir sur facture", scan_to_pay: "Scanner pour payer", page: "Page" },
};
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" }, { code: "sl", name: "Slovenščina" }, { code: "hr", name: "Hrvatski" }, { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" }, { code: "es", name: "Español" }, { code: "fr", name: "Français" },
];
export const labels = (lang: string): Labels => LABELS[lang] ?? LABELS.en;
export const LOCALE: Record<string, string> = { en: "en-GB", sl: "sl-SI", hr: "hr-HR", de: "de-DE", it: "it-IT", es: "es-ES", fr: "fr-FR" };

// ---------------------------------------------------------------- SEPA payment QR (EPC069-12)

/** The text of an EPC "SEPA credit transfer" QR code, or null when it can't be made (not EUR, no IBAN, amount out of range). */
export function epcQrText(o: { name: string; iban: string; bic?: string; amount: number; currency: string; reference: string; text?: string }): string | null {
  const iban = o.iban.replace(/\s+/g, "").toUpperCase();
  if (o.currency !== "EUR" || !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban) || !(o.amount > 0 && o.amount <= 999999999.99) || !o.name.trim()) return null;
  return ["BCD", "002", "1", "SCT", (o.bic ?? "").replace(/\s+/g, "").toUpperCase(), o.name.trim().slice(0, 70), iban, `EUR${round2(o.amount).toFixed(2)}`, "", "", (o.text || o.reference).slice(0, 140)].join("\n");
}

// ---------------------------------------------------------------- e-invoice (EN 16931, Peppol BIS Billing 3.0, UBL 2.1)

const x = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const amt = (n: number) => round2(n).toFixed(2);

function party(p: { name: string; address: string; country: string; vat_id: string; reg_no?: string; email?: string }, tag: string): string {
  const lines = p.address.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
  return `<cac:${tag}><cac:Party>${p.email ? `<cbc:EndpointID schemeID="EM">${x(p.email.split(/[,;]/)[0].trim())}</cbc:EndpointID>` : ""}<cac:PostalAddress>${lines[0] ? `<cbc:StreetName>${x(lines[0])}</cbc:StreetName>` : ""}${lines[1] ? `<cbc:CityName>${x(lines.slice(1).join(", "))}</cbc:CityName>` : ""}<cac:Country><cbc:IdentificationCode>${x(p.country || "XX")}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>${p.vat_id ? `<cac:PartyTaxScheme><cbc:CompanyID>${x(p.vat_id)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ""}<cac:PartyLegalEntity><cbc:RegistrationName>${x(p.name)}</cbc:RegistrationName>${p.reg_no ? `<cbc:CompanyID>${x(p.reg_no)}</cbc:CompanyID>` : ""}</cac:PartyLegalEntity></cac:Party></cac:${tag}>`;
}

/** The issued invoice as a UBL 2.1 document following Peppol BIS Billing 3.0 (EN 16931). */
export function ublXml(inv: Invoice, lines: Line[], creditNumber?: string | null): string {
  const credit = inv.kind === "credit_note";
  const root = credit ? "CreditNote" : "Invoice";
  const sign = credit ? -1 : 1;
  const s = inv.seller as Seller;
  const items = lines.filter((l) => l.kind === "item");
  const cur = inv.currency;
  const exemption = (c: TaxCategory, note: string) => (c === "S" || !note ? "" : `<cbc:TaxExemptionReason>${x(note)}</cbc:TaxExemptionReason>`);
  const pct = (n: number) => String(Number(n));
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
<cbc:ID>${x(inv.number)}</cbc:ID>
<cbc:IssueDate>${inv.issue_date}</cbc:IssueDate>
${!credit && inv.due_date ? `<cbc:DueDate>${inv.due_date}</cbc:DueDate>` : ""}
<cbc:${root}TypeCode>${credit ? "381" : "380"}</cbc:${root}TypeCode>
${inv.notes ? `<cbc:Note>${x(inv.notes)}</cbc:Note>` : ""}
<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
${inv.reference ? `<cbc:BuyerReference>${x(inv.reference)}</cbc:BuyerReference>` : `<cbc:BuyerReference>${x(inv.number)}</cbc:BuyerReference>`}
${inv.supply_from || inv.supply_to ? `<cac:InvoicePeriod>${inv.supply_from ? `<cbc:StartDate>${inv.supply_from}</cbc:StartDate>` : ""}${inv.supply_to ? `<cbc:EndDate>${inv.supply_to}</cbc:EndDate>` : ""}</cac:InvoicePeriod>` : ""}
${credit && creditNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${x(creditNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
${party({ name: s.legal_name || s.name, address: s.address, country: s.country, vat_id: s.vat_id, reg_no: s.reg_no, email: s.email }, "AccountingSupplierParty")}
${party({ name: inv.bill_name, address: inv.bill_address, country: inv.bill_country, vat_id: inv.bill_vat_id, email: inv.bill_email }, "AccountingCustomerParty")}
${!credit && s.iban ? `<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>${x(inv.number)}</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${x(s.iban.replace(/\s+/g, ""))}</cbc:ID>${s.bic ? `<cac:FinancialInstitutionBranch><cbc:ID>${x(s.bic)}</cbc:ID></cac:FinancialInstitutionBranch>` : ""}</cac:PayeeFinancialAccount></cac:PaymentMeans>` : ""}
${Number(inv.discount_total) ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason><cbc:MultiplierFactorNumeric>${pct(inv.discount_pct)}</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="${cur}">${amt(sign * Number(inv.discount_total))}</cbc:Amount><cbc:BaseAmount currencyID="${cur}">${amt(sign * Number(inv.subtotal))}</cbc:BaseAmount><cac:TaxCategory><cbc:ID>${inv.tax_breakdown[0]?.category ?? "S"}</cbc:ID><cbc:Percent>${pct(inv.tax_breakdown[0]?.rate ?? 0)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:AllowanceCharge>` : ""}
<cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${amt(sign * Number(inv.tax_total))}</cbc:TaxAmount>${inv.tax_breakdown
    .map((b) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${cur}">${amt(sign * b.base)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${cur}">${amt(sign * b.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${b.category}</cbc:ID><cbc:Percent>${pct(b.rate)}</cbc:Percent>${exemption(b.category, b.note ?? "")}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`)
    .join("")}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${cur}">${amt(sign * Number(inv.subtotal))}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${cur}">${amt(sign * (Number(inv.total) - Number(inv.tax_total)))}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${cur}">${amt(sign * Number(inv.total))}</cbc:TaxInclusiveAmount>${Number(inv.discount_total) ? `<cbc:AllowanceTotalAmount currencyID="${cur}">${amt(sign * Number(inv.discount_total))}</cbc:AllowanceTotalAmount>` : ""}<cbc:PayableAmount currencyID="${cur}">${amt(sign * Number(inv.total))}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${items
  .map(
    (l, i) => `<cac:${root}Line><cbc:ID>${i + 1}</cbc:ID><cbc:${credit ? "Credited" : "Invoiced"}Quantity unitCode="C62">${String(sign * Number(l.quantity))}</cbc:${credit ? "Credited" : "Invoiced"}Quantity><cbc:LineExtensionAmount currencyID="${cur}">${amt(sign * Number(l.net))}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${x(l.description.split("\n")[0].slice(0, 200))}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${l.tax_category}</cbc:ID><cbc:Percent>${pct(l.tax_rate)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${cur}">${(Math.abs(Number(l.unit_price)) * (1 - Number(l.discount_pct) / 100)).toFixed(4)}</cbc:PriceAmount></cac:Price></cac:${root}Line>`,
  )
  .join("\n")}
</${root}>`.replace(/\n{2,}/g, "\n");
}
