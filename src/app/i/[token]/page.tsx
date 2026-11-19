"use client";

// The online invoice a client opens from the email (no account needed): the
// invoice as a PDF, its status, how to pay, and a download button.
import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { balanceOf, epcQrText, labels, money, type Invoice, type Line } from "@/lib/invoices";
import { supabase } from "@/lib/supabase";

type Public = Invoice & { lines: Line[] };

export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [inv, setInv] = useState<Public | null | undefined>(undefined);
  const [pdf, setPdf] = useState<{ url: string; blob: Blob } | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const { data, error } = await supabase().rpc("invoice_public", { p_token: token });
      if (!live) return;
      if (error || !data) return setInv(null);
      const raw = data as Public;
      const n = (x: unknown) => Number(x ?? 0);
      const i: Public = {
        ...raw,
        subtotal: n(raw.subtotal),
        discount_total: n(raw.discount_total),
        tax_total: n(raw.tax_total),
        total: n(raw.total),
        paid_amount: n(raw.paid_amount),
        credited_amount: n(raw.credited_amount),
        discount_pct: n(raw.discount_pct),
        lines: raw.lines.map((l) => ({ ...l, quantity: n(l.quantity), unit_price: n(l.unit_price), discount_pct: n(l.discount_pct), tax_rate: n(l.tax_rate), net: n(l.net) })),
      };
      setInv(i);
      const { renderInvoicePdf } = await import("@/components/invoices/InvoicePdf");
      const blob = await renderInvoicePdf({ invoice: i, lines: i.lines, seller: i.seller });
      if (live) setPdf({ url: URL.createObjectURL(blob), blob });
      const text = i.show_qr && i.kind === "invoice" && i.status === "issued" ? epcQrText({ name: i.seller.legal_name || i.seller.name || "", iban: i.seller.iban || "", bic: i.seller.bic, amount: balanceOf(i), currency: i.currency, reference: i.number || "" }) : null;
      if (text) {
        const QR = (await import("qrcode")).default;
        const url = await QR.toDataURL(text, { margin: 1, width: 220 });
        if (live) setQr(url);
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  if (inv === undefined) return <div className="flex h-full items-center justify-center text-sm text-gray-500"><Loader2 size={16} className="mr-2 animate-spin" /> Loading the invoice…</div>;
  if (inv === null)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">This invoice isn&apos;t available</h1>
          <p className="mt-1 text-sm text-gray-600">The link may be mistyped, or the invoice was withdrawn. Please contact the sender.</p>
        </div>
      </div>
    );

  const L = labels(inv.language);
  const balance = balanceOf(inv);
  const paid = inv.status === "paid" || (inv.kind === "invoice" && balance <= 0);
  const name = `${inv.number ?? "invoice"}.pdf`;
  const title = `${L[inv.kind]} ${inv.number ?? ""}`;
  return (
    <div className="flex h-full flex-col bg-gray-100 md:flex-row">
      <aside className="w-full shrink-0 space-y-4 border-b border-gray-200 bg-white p-6 md:w-80 md:border-b-0 md:border-r">
        {inv.seller.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={inv.seller.logo_url} alt={inv.seller.name ?? ""} className="max-h-12 max-w-[200px] object-contain" />
        ) : (
          <div className="text-lg font-semibold">{inv.seller.name}</div>
        )}
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-gray-600">{inv.bill_name}</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">{paid ? L.total : L.balance}</div>
          <div className="text-2xl font-semibold tabular-nums">{money(paid ? inv.total : balance, inv.currency)}</div>
          {inv.status === "void" ? (
            <p className="mt-1 text-sm font-medium text-gray-700">This document was cancelled.</p>
          ) : paid && inv.kind === "invoice" ? (
            <p className="mt-1 flex items-center gap-1 text-sm font-medium text-emerald-700"><CheckCircle2 size={14} /> Paid, thank you</p>
          ) : inv.due_date && inv.kind !== "credit_note" ? (
            <p className="mt-1 text-sm text-gray-600">{L.due_date}: {inv.due_date}</p>
          ) : null}
        </div>
        {inv.kind === "invoice" && !paid && inv.status === "issued" && inv.seller.iban && (
          <div className="space-y-1 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{L.bank}</div>
            <div>{inv.seller.legal_name || inv.seller.name}</div>
            <div className="font-mono">{inv.seller.iban}</div>
            {inv.seller.bic && <div>BIC {inv.seller.bic}</div>}
            <div>{L.reference}: {inv.number}</div>
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Payment QR code (scan in your banking app)" className="mt-2 h-36 w-36" />
            )}
          </div>
        )}
        <button
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          disabled={!pdf}
          onClick={() => {
            if (!pdf) return;
            const a = document.createElement("a");
            a.href = pdf.url;
            a.download = name;
            a.click();
          }}
        >
          <Download size={15} /> Download PDF
        </button>
        {inv.seller.email && <p className="text-xs text-gray-500">Questions? <a className="underline" href={`mailto:${inv.seller.email}`}>{inv.seller.email}</a></p>}
      </aside>
      <main className="min-h-[70vh] flex-1">
        {pdf ? <iframe src={`${pdf.url}#view=FitH`} title={title} className="h-full min-h-[70vh] w-full" /> : <div className="flex h-full items-center justify-center text-sm text-gray-500"><Loader2 size={16} className="mr-2 animate-spin" /> Preparing the PDF…</div>}
      </main>
    </div>
  );
}
