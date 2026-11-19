// The invoice as a PDF (@react-pdf/renderer): the same file for the preview,
// the download, the stored legal copy and the email attachment. Four designs
// (classic, modern, minimal, bold), the brand colour, labels in the invoice's
// language, tax per rate, and an optional SEPA payment QR code.
// Loaded only on invoice pages (the library is large).
import { Document, Font, Image, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { LOCALE, balanceOf, epcQrText, labels, money, qty, type Invoice, type Line, type Seller } from "@/lib/invoices";

let fontsReady = false;
/** The fonts come from /fonts of the app (tests pass a folder instead). */
export function registerFonts(base = typeof window === "undefined" ? "" : window.location.origin) {
  if (fontsReady || !base) return;
  fontsReady = true;
  Font.register({
    family: "Inter",
    fonts: [
      { src: `${base}/fonts/Inter_400Regular.ttf`, fontWeight: 400 },
      { src: `${base}/fonts/Inter_600SemiBold.ttf`, fontWeight: 600 },
      { src: `${base}/fonts/Inter_700Bold.ttf`, fontWeight: 700 },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
}

export interface PdfInput {
  invoice: Invoice;
  lines: Line[];
  seller: Partial<Seller>;
  /** The number of the invoice a credit note corrects. */
  creditFor?: string | null;
  /** Shown big and grey across drafts. */
  draft?: boolean;
}

const date = (iso: string | null | undefined, lang: string) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(LOCALE[lang] ?? "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

function styles(color: string, template: Invoice["template"]) {
  const bold = template === "bold";
  const minimal = template === "minimal";
  return StyleSheet.create({
    page: { fontFamily: "Inter", fontSize: 9, color: "#1f2330", paddingTop: bold ? 0 : 40, paddingBottom: 60, paddingHorizontal: 40, lineHeight: 1.35 },
    band: { backgroundColor: color, marginHorizontal: -40, paddingHorizontal: 40, paddingTop: 32, paddingBottom: 24, marginBottom: 24, color: "#ffffff" },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: bold ? 0 : 28 },
    logo: { maxHeight: 54, maxWidth: 170, objectFit: "contain" },
    title: { fontSize: template === "modern" ? 26 : 22, lineHeight: 1.15, fontWeight: 700, color: bold ? "#ffffff" : minimal ? "#1f2330" : color, textAlign: "right" },
    muted: { color: bold ? "#e9e6fb" : "#6b7280" },
    small: { fontSize: 8, color: "#6b7280" },
    row: { flexDirection: "row" },
    parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 22, gap: 24 },
    party: { width: "48%" },
    label: { fontSize: 7.5, fontWeight: 600, color: minimal ? "#6b7280" : color, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
    meta: { flexDirection: "row", flexWrap: "wrap", borderTopWidth: minimal ? 0 : 1, borderBottomWidth: minimal ? 0 : 1, borderColor: "#e5e7eb", paddingVertical: 8, marginBottom: 16 },
    metaItem: { width: "25%", paddingRight: 6, marginBottom: 2 },
    th: { flexDirection: "row", backgroundColor: template === "classic" || bold ? color : "#ffffff", color: template === "classic" || bold ? "#ffffff" : "#6b7280", borderBottomWidth: template === "classic" || bold ? 0 : 1, borderColor: "#1f2330", paddingVertical: 5, paddingHorizontal: 4, fontWeight: 600, fontSize: 8 },
    tr: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 0.5, borderColor: "#e5e7eb" },
    heading: { paddingTop: 9, paddingBottom: 3, paddingHorizontal: 4, fontWeight: 700 },
    cDesc: { flex: 1, paddingRight: 6 },
    cQty: { width: 42, textAlign: "right" },
    cUnit: { width: 34, paddingLeft: 4 },
    cPrice: { width: 64, textAlign: "right" },
    cDisc: { width: 38, textAlign: "right" },
    cVat: { width: 34, textAlign: "right" },
    cAmt: { width: 70, textAlign: "right" },
    totals: { marginTop: 12, marginLeft: "auto", width: 230 },
    tline: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5 },
    grand: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, marginTop: 4, borderTopWidth: 1.5, borderColor: minimal ? "#1f2330" : color, fontSize: 12, fontWeight: 700 },
    block: { marginTop: 18 },
    footer: { position: "absolute", bottom: 24, left: 40, right: 110, fontSize: 7.5, lineHeight: 1.3, color: "#6b7280", borderTopWidth: 0.5, borderColor: "#e5e7eb", paddingTop: 6 },
    pageNo: { position: "absolute", bottom: 21, left: 40, width: 515, lineHeight: 1.2, fontSize: 7.5, color: "#6b7280", paddingTop: 6.5 },
    watermark: { position: "absolute", top: 330, left: 0, right: 0, textAlign: "center", fontSize: 90, fontWeight: 700, color: "#000000", opacity: 0.05, transform: "rotate(-30deg)" },
  });
}

function InvoiceDocument({ invoice: inv, lines, seller, creditFor, draft, qrDataUrl }: PdfInput & { qrDataUrl: string | null }) {
  const L = labels(inv.language);
  const loc = LOCALE[inv.language] ?? "en-GB";
  const s = styles(inv.color || "#5a43d9", inv.template);
  const m = (n: number) => money(n, inv.currency, loc);
  const title = L[inv.kind];
  const showDisc = lines.some((l) => l.kind === "item" && Number(l.discount_pct) > 0);
  const balance = balanceOf(inv);
  const legalName = seller.legal_name || seller.name || "";
  const notesForTax = inv.tax_breakdown.filter((b) => b.category !== "S" && b.note).map((b) => b.note!);
  const bold = inv.template === "bold";

  const head = (
    <View style={s.header}>
      <View style={{ maxWidth: "55%" }}>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt attribute */}
        {seller.logo_url ? <Image src={seller.logo_url} style={s.logo} /> :<Text style={{ fontSize: 14, fontWeight: 700 }}>{seller.name}</Text>}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={s.title}>{title}</Text>
        <Text style={[s.muted, { fontSize: 10, marginTop: 4, lineHeight: 1.2 }]}>{inv.number ?? (draft ? "Draft" : "")}</Text>
      </View>
    </View>
  );

  return (
    <Document title={`${title} ${inv.number ?? ""}`.trim()} author={legalName} creator="LM Data Universe" producer="LM Data Universe">
      <Page size="A4" style={s.page}>
        {draft && <Text style={s.watermark} fixed>DRAFT</Text>}
        {bold ? <View style={s.band}>{head}</View> : head}

        <View style={s.parties}>
          <View style={s.party}>
            <Text style={s.label}>{legalName}</Text>
            <Text>{seller.address}</Text>
            {seller.vat_id ? <Text>{L.vat_id}: {seller.vat_id}</Text> : null}
            {seller.reg_no ? <Text>{L.reg_no}: {seller.reg_no}</Text> : null}
            {seller.email ? <Text style={s.small}>{[seller.email, seller.phone, seller.website].filter(Boolean).join(" · ")}</Text> : null}
          </View>
          <View style={s.party}>
            <Text style={s.label}>{L.bill_to}</Text>
            <Text style={{ fontWeight: 600 }}>{inv.bill_name}</Text>
            <Text>{inv.bill_address}</Text>
            {inv.bill_vat_id ? <Text>{L.vat_id}: {inv.bill_vat_id}</Text> : null}
          </View>
        </View>

        <View style={s.meta}>
          <View style={s.metaItem}>
            <Text style={s.label}>{L.issue_date}</Text>
            <Text>{date(inv.issue_date, inv.language)}</Text>
          </View>
          {inv.kind !== "credit_note" && inv.due_date ? (
            <View style={s.metaItem}>
              <Text style={s.label}>{L.due_date}</Text>
              <Text>{date(inv.due_date, inv.language)}</Text>
            </View>
          ) : null}
          {inv.supply_from || inv.supply_to ? (
            <View style={s.metaItem}>
              <Text style={s.label}>{L.supply}</Text>
              <Text>{[inv.supply_from, inv.supply_to].filter(Boolean).map((d) => date(d, inv.language)).join(" – ")}</Text>
            </View>
          ) : null}
          {inv.reference ? (
            <View style={s.metaItem}>
              <Text style={s.label}>{L.reference}</Text>
              <Text>{inv.reference}</Text>
            </View>
          ) : null}
          {creditFor ? (
            <View style={s.metaItem}>
              <Text style={s.label}>{L.credit_for}</Text>
              <Text>{creditFor}</Text>
            </View>
          ) : null}
        </View>

        {/* The header repeats on every page the line table runs over (and only those). */}
        <View>
        <View style={s.th} fixed>
          <Text style={s.cDesc}>{L.description}</Text>
          <Text style={s.cQty}>{L.quantity}</Text>
          <Text style={s.cUnit}>{L.unit}</Text>
          <Text style={s.cPrice}>{L.price}</Text>
          {showDisc ? <Text style={s.cDisc}>{L.discount}</Text> : null}
          <Text style={s.cVat}>{L.vat}</Text>
          <Text style={s.cAmt}>{L.amount}</Text>
        </View>
        {lines.map((l) =>
          l.kind === "heading" ? (
            <Text key={l.id} style={s.heading} wrap={false}>
              {l.description}
            </Text>
          ) : (
            <View key={l.id} style={s.tr} wrap={false}>
              <Text style={s.cDesc}>{l.description}</Text>
              <Text style={s.cQty}>{qty(l.quantity, loc)}</Text>
              <Text style={s.cUnit}>{l.unit}</Text>
              <Text style={s.cPrice}>{m(l.unit_price)}</Text>
              {showDisc ? <Text style={s.cDisc}>{Number(l.discount_pct) ? `${qty(l.discount_pct, loc)}%` : ""}</Text> : null}
              <Text style={s.cVat}>{l.tax_category === "S" ? `${qty(l.tax_rate, loc)}%` : l.tax_category}</Text>
              <Text style={s.cAmt}>{m(l.net)}</Text>
            </View>
          ),
        )}
        </View>

        <View style={s.totals} wrap={false}>
          <View style={s.tline}>
            <Text>{L.subtotal}</Text>
            <Text>{m(inv.subtotal)}</Text>
          </View>
          {Number(inv.discount_total) ? (
            <View style={s.tline}>
              <Text>
                {L.discount} {qty(inv.discount_pct, loc)}%
              </Text>
              <Text>−{m(inv.discount_total)}</Text>
            </View>
          ) : null}
          {inv.tax_breakdown.map((b) => (
            <View key={`${b.rate}${b.category}`} style={s.tline}>
              <Text>
                {L.vat} {b.category === "S" ? `${qty(b.rate, loc)}%` : b.category} ({m(b.base)})
              </Text>
              <Text>{m(b.tax)}</Text>
            </View>
          ))}
          <View style={s.grand}>
            <Text>{L.total}</Text>
            <Text>{m(inv.total)}</Text>
          </View>
          {Number(inv.paid_amount) || Number(inv.credited_amount) ? (
            <>
              <View style={s.tline}>
                <Text>{L.paid}</Text>
                <Text>−{m(Number(inv.paid_amount) + Number(inv.credited_amount))}</Text>
              </View>
              <View style={[s.tline, { fontWeight: 700 }]}>
                <Text>{L.balance}</Text>
                <Text>{m(balance)}</Text>
              </View>
            </>
          ) : null}
        </View>

        {notesForTax.length ? (
          <View style={s.block} wrap={false}>
            {notesForTax.map((n) => (
              <Text key={n} style={{ fontWeight: 600 }}>
                {n}
              </Text>
            ))}
          </View>
        ) : null}

        {inv.kind !== "credit_note" && inv.kind !== "quote" && (seller.iban || qrDataUrl) ? (
          <View style={[s.block, s.row, { justifyContent: "space-between", alignItems: "flex-start" }]} wrap={false}>
            <View style={{ width: "70%" }}>
              <Text style={s.label}>{L.bank}</Text>
              {seller.bank_name ? <Text>{seller.bank_name}</Text> : null}
              {seller.iban ? <Text>IBAN: {seller.iban}</Text> : null}
              {seller.bic ? <Text>BIC: {seller.bic}</Text> : null}
              <Text>
                {L.reference}: {inv.number ?? ""}
              </Text>
            </View>
            {qrDataUrl ? (
              <View style={{ alignItems: "center" }}>
                {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt attribute */}
                <Image src={qrDataUrl} style={{ width: 78, height: 78 }} />
                <Text style={s.small}>{L.scan_to_pay}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {inv.notes ? (
          <View style={s.block} wrap={false}>
            <Text style={s.label}>{L.notes}</Text>
            <Text>{inv.notes}</Text>
          </View>
        ) : null}
        {inv.terms ? (
          <View style={s.block} wrap={false}>
            <Text style={s.label}>{L.terms}</Text>
            <Text style={s.small}>{inv.terms}</Text>
          </View>
        ) : null}

        <Text style={s.footer} fixed>
          {seller.footer || [legalName, seller.address, seller.vat_id && `${L.vat_id} ${seller.vat_id}`].filter(Boolean).join(" · ")}
        </Text>
        {/* react-pdf 4.9 drops render() text that inherits the page's lineHeight, so it sets its own. */}
        {/* (totalPages is passed to View render() too, only missing from the library's types.) */}
        <View style={s.pageNo} fixed render={(p) => <Text style={{ textAlign: "right", lineHeight: 1.2 }}>{`${L.page} ${p.pageNumber}/${(p as { totalPages?: number }).totalPages ?? ""}`}</Text>} />
      </Page>
    </Document>
  );
}

/** The invoice as a PDF file. */
export async function renderInvoicePdf(input: PdfInput): Promise<Blob> {
  registerFonts();
  const inv = input.invoice;
  const text =
    inv.show_qr && inv.kind !== "credit_note" && inv.kind !== "quote"
      ? epcQrText({ name: input.seller.legal_name || input.seller.name || "", iban: input.seller.iban || "", bic: input.seller.bic, amount: balanceOf(inv) || Number(inv.total), currency: inv.currency, reference: inv.number || "" })
      : null;
  const qrDataUrl = text ? await QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 0, width: 240 }) : null;
  return pdf(<InvoiceDocument {...input} qrDataUrl={qrDataUrl} />).toBlob();
}
