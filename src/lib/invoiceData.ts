// Loading and saving invoice data (Supabase), and issuing: the database numbers
// and locks the invoice, then the browser makes the PDF and the e-invoice XML,
// stores them in the private "invoices" bucket and records them.
import { errorMessage, supabase } from "./supabase";
import { defaultTaxRates, ublXml, type Invoice, type Line, type Profile, type Service, type Series, type TaxRate } from "./invoices";

export interface InvoiceSettings {
  profiles: Profile[];
  taxes: TaxRate[];
  services: Service[];
  series: Series[];
}

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

export async function loadSettings(docId: string): Promise<InvoiceSettings> {
  const sb = supabase();
  const [p, t, s, n] = await Promise.all([
    sb.from("invoice_profiles").select("*").eq("doc_id", docId).order("created_at"),
    sb.from("invoice_tax_rates").select("*").eq("doc_id", docId).order("position"),
    sb.from("invoice_services").select("*").eq("doc_id", docId).order("name"),
    sb.from("invoice_series").select("*").eq("doc_id", docId),
  ]);
  return { profiles: must(p) as Profile[], taxes: must(t) as TaxRate[], services: must(s) as Service[], series: must(n) as Series[] };
}

/** First-time setup: a business profile, the country's tax rates and the numbering. */
export async function setUpInvoicing(docId: string, o: { name: string; country: string; currency: string; vatRegistered: boolean; language: string }): Promise<void> {
  const sb = supabase();
  const profile = must(
    await sb.from("invoice_profiles").insert({ doc_id: docId, name: o.name, legal_name: o.name, country: o.country, currency: o.currency, vat_registered: o.vatRegistered, language: o.language, is_default: true }).select().single(),
  ) as Profile;
  const rates = defaultTaxRates(o.country).map((r, i) => ({ ...r, doc_id: docId, position: i, ...(o.vatRegistered ? {} : r.category === "S" ? { is_default: false } : {}) }));
  if (!o.vatRegistered) rates.push({ name: "No VAT (not VAT registered)", rate: 0, category: "O", note: "Not subject to VAT: the seller is not VAT registered", is_default: true, doc_id: docId, position: rates.length });
  must(await sb.from("invoice_tax_rates").insert(rates));
  must(
    await sb.from("invoice_series").insert([
      { doc_id: docId, profile_id: profile.id, kind: "invoice", pattern: "{YYYY}-{####}" },
      { doc_id: docId, profile_id: profile.id, kind: "credit_note", pattern: "CN-{YYYY}-{####}" },
      { doc_id: docId, profile_id: profile.id, kind: "quote", pattern: "Q-{YYYY}-{####}" },
      { doc_id: docId, profile_id: profile.id, kind: "proforma", pattern: "PF-{YYYY}-{####}" },
    ]),
  );
}

export async function loadInvoice(id: string): Promise<{ invoice: Invoice; lines: Line[] }> {
  const sb = supabase();
  const [i, l] = await Promise.all([sb.from("invoices").select("*").eq("id", id).maybeSingle(), sb.from("invoice_lines").select("*").eq("invoice_id", id).order("position")]);
  const invoice = must(i) as Invoice | null;
  if (!invoice) throw new Error("This invoice doesn't exist, or you can't see it.");
  return { invoice, lines: (must(l) as Line[]).map((x) => ({ ...x, quantity: Number(x.quantity), unit_price: Number(x.unit_price), discount_pct: Number(x.discount_pct), tax_rate: Number(x.tax_rate), net: Number(x.net) })) };
}

/** A new draft with the profile's defaults (and the client's remembered billing details). */
export async function createDraft(docId: string, s: InvoiceSettings, o: { kind?: Invoice["kind"]; clientRow?: number | null; clientName?: string } = {}): Promise<string> {
  const p = s.profiles.find((x) => x.is_default) ?? s.profiles[0];
  if (!p) throw new Error("Set up invoicing first (Settings).");
  const sb = supabase();
  let bill: Record<string, unknown> = {};
  if (o.clientRow) {
    const { data } = await sb.from("invoice_billing").select("*").eq("doc_id", docId).eq("client_row", o.clientRow).maybeSingle();
    bill = {
      bill_name: data?.name || o.clientName || "",
      bill_address: data?.address ?? "",
      bill_country: data?.country ?? "",
      bill_vat_id: data?.vat_id ?? "",
      bill_email: data?.email ?? "",
      ...(data?.language ? { language: data.language } : {}),
      ...(data?.currency ? { currency: data.currency } : {}),
    };
  }
  const today = new Date().toISOString().slice(0, 10);
  const terms = (bill as { terms_days?: number }).terms_days ?? p.terms_days;
  const row = must(
    await sb
      .from("invoices")
      .insert({
        doc_id: docId,
        profile_id: p.id,
        kind: o.kind ?? "invoice",
        client_row: o.clientRow ?? null,
        issue_date: today,
        due_date: o.kind === "quote" ? null : new Date(Date.now() + terms * 86400000).toISOString().slice(0, 10),
        currency: p.currency,
        language: p.language,
        template: p.template,
        color: p.color,
        show_qr: p.show_qr,
        notes: p.notes,
        terms: p.terms,
        ...bill,
      })
      .select()
      .single(),
  ) as Invoice;
  const tax = s.taxes.find((t) => t.is_default) ?? s.taxes[0];
  must(await sb.from("invoice_lines").insert({ invoice_id: row.id, position: 1, description: "", quantity: 1, unit: "", unit_price: 0, tax_rate_id: tax?.id ?? null, tax_rate: tax?.rate ?? 0, tax_category: tax?.category ?? "S", tax_note: tax?.note ?? "" }));
  return row.id;
}

async function sha256(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "invoice";

/** Makes, stores and records the PDF and XML of an issued invoice that has none yet. */
export async function storeIssuedFiles(id: string): Promise<void> {
  const { invoice, lines } = await loadInvoice(id);
  if (invoice.status === "draft" || invoice.pdf_path) return;
  let creditFor: string | null = null;
  if (invoice.credit_of) {
    const { data } = await supabase().from("invoices").select("number").eq("id", invoice.credit_of).maybeSingle();
    creditFor = (data?.number as string | undefined) ?? null;
  }
  const { renderInvoicePdf } = await import("@/components/invoices/InvoicePdf");
  const pdf = await renderInvoicePdf({ invoice, lines, seller: invoice.seller, creditFor });
  const base = `${invoice.doc_id}/${invoice.id}/${safe(invoice.number ?? "invoice")}`;
  const sb = supabase().storage.from("invoices");
  const up = await sb.upload(`${base}.pdf`, pdf, { contentType: "application/pdf", upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`The PDF couldn't be stored: ${up.error.message}`);
  let xmlPath: string | null = null;
  if (invoice.kind === "invoice" || invoice.kind === "credit_note") {
    const xml = new Blob([ublXml(invoice, lines, creditFor)], { type: "application/xml" });
    const ux = await sb.upload(`${base}.xml`, xml, { contentType: "application/xml", upsert: false });
    if (!ux.error || /exists|duplicate/i.test(ux.error.message)) xmlPath = `${base}.xml`;
  }
  const { error } = await supabase().rpc("invoice_attach_files", { p_id: id, p_pdf: `${base}.pdf`, p_sha256: await sha256(pdf), p_xml: xmlPath });
  if (error) throw new Error(errorMessage(error));
}

/** A short-lived link to a stored invoice file. */
export async function invoiceFileUrl(path: string, download?: string): Promise<string | null> {
  const { data } = await supabase().storage.from("invoices").createSignedUrl(path, 600, download ? { download } : undefined);
  return data?.signedUrl ?? null;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
