"use client";

// One invoice (or quote, credit note, pro forma): the form on the left, the
// real PDF on the right. Drafts save themselves; issuing numbers and locks it.
import clsx from "clsx";
import { ArrowLeft, Ban, CheckCircle2, Copy, Download, FileCode2, GripVertical, Heading, Link2, Loader2, Mail, Plus, Receipt, Repeat, RotateCcw, Search, Send, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Label, Modal, Select, useDialogs } from "@/components/ui";
import { CATEGORY_LABEL, LANGUAGES, addDays, balanceOf, computeTotals, displayStatus, formatNumber, money, type Invoice, type Line, type TaxRate } from "@/lib/invoices";
import { downloadBlob, invoiceFileUrl, loadInvoice, storeIssuedFiles, type InvoiceSettings } from "@/lib/invoiceData";
import { errorMessage, supabase } from "@/lib/supabase";
import { getDerived, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { tileTitleText } from "../doc/RecordTile";
import { StatusChip } from "./InvoicesSection";

const TONE = "rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const KIND_LABEL: Record<Invoice["kind"], string> = { invoice: "Invoice", credit_note: "Credit note", quote: "Quote", proforma: "Pro forma" };
const TERMS = [0, 7, 14, 30, 45, 60];
// What a draft's form may change (the rest is set by issuing, payments, sending).
const EDITABLE = ["profile_id", "kind", "client_row", "bill_name", "bill_address", "bill_country", "bill_vat_id", "bill_email", "issue_date", "supply_from", "supply_to", "due_date", "reference", "currency", "language", "template", "color", "show_qr", "notes", "terms", "discount_pct"] as const satisfies readonly (keyof Invoice)[];

interface Payment {
  id: string;
  paid_on: string;
  amount: number;
  method: string;
  reference: string;
}
interface EventRow {
  id: number;
  kind: string;
  at: string;
  details: Record<string, unknown>;
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}

export function InvoiceEditor({ id, wsId, settings, clientsTable }: { id: string; wsId: string; settings: InvoiceSettings; clientsTable: string }) {
  const router = useRouter();
  const role = useDoc((s) => s.role);
  const version = useDoc((s) => s.version);
  const canEdit = role === "owner" || role === "editor";
  const { confirm, prompt } = useDialogs();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [creditFor, setCreditFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const [busy, setBusy] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [svcQuery, setSvcQuery] = useState("");
  const [vat, setVat] = useState<string | null>(null);
  const dirty = useRef<{ inv: boolean; lines: boolean }>({ inv: false, lines: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const removed = useRef<string[]>([]);

  const reload = useCallback(async () => {
    try {
      const r = await loadInvoice(id);
      setInv(r.invoice);
      setLines(r.lines);
      setError(null);
      const sb = supabase();
      const [p, e] = await Promise.all([
        sb.from("invoice_payments").select("id,paid_on,amount,method,reference").eq("invoice_id", id).order("paid_on"),
        sb.from("invoice_events").select("id,kind,at,details").eq("invoice_id", id).order("at", { ascending: false }).limit(50),
      ]);
      setPayments(((p.data as Payment[] | null) ?? []).map((x) => ({ ...x, amount: Number(x.amount) })));
      setEvents((e.data as EventRow[] | null) ?? []);
      if (r.invoice.credit_of) {
        const { data } = await sb.from("invoices").select("number").eq("id", r.invoice.credit_of).maybeSingle();
        setCreditFor((data?.number as string | undefined) ?? null);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
  }, [reload]);

  const draft = inv?.status === "draft";
  const editable = !!inv && draft && canEdit;
  const profile = settings.profiles.find((p) => p.id === inv?.profile_id) ?? settings.profiles[0];
  const totals = useMemo(() => computeTotals(lines, inv?.discount_pct ?? 0), [lines, inv?.discount_pct]);
  // While drafting, totals are worked out here; the database recomputes them when issuing.
  const shown: Invoice | null = inv && (draft ? { ...inv, subtotal: totals.subtotal, discount_total: totals.discount, tax_total: totals.tax, total: totals.total, tax_breakdown: totals.breakdown } : inv);
  const shownLines = useMemo(() => (draft ? lines.map((l) => ({ ...l, net: totals.nets.get(l.id) ?? 0 })) : lines), [draft, lines, totals]);

  // ---- saving drafts
  const save = useCallback(async () => {
    if (!inv || inv.status !== "draft") return;
    const sb = supabase();
    setSaving("saving");
    try {
      if (dirty.current.inv) {
        dirty.current.inv = false;
        const rest = Object.fromEntries(EDITABLE.map((k) => [k, inv[k]]));
        const { error } = await sb.from("invoices").update({ ...rest, subtotal: totals.subtotal, discount_total: totals.discount, tax_total: totals.tax, total: totals.total, tax_breakdown: totals.breakdown }).eq("id", inv.id);
        if (error) throw error;
        if (inv.client_row) {
          await sb.from("invoice_billing").upsert({ doc_id: inv.doc_id, client_row: inv.client_row, name: inv.bill_name, address: inv.bill_address, country: inv.bill_country, vat_id: inv.bill_vat_id, email: inv.bill_email, language: inv.language, currency: inv.currency });
        }
      }
      if (dirty.current.lines) {
        dirty.current.lines = false;
        if (removed.current.length) {
          const gone = removed.current;
          removed.current = [];
          const { error } = await sb.from("invoice_lines").delete().in("id", gone);
          if (error) throw error;
        }
        const rows = lines.map((l, i) => ({ ...l, position: i + 1, net: totals.nets.get(l.id) ?? 0 }));
        if (rows.length) {
          const { error } = await sb.from("invoice_lines").upsert(rows.map(({ doc_id: _d, ...r }: Line & { doc_id?: string }) => (void _d, r)));
          if (error) throw error;
        }
        if (!dirty.current.inv) await sb.from("invoices").update({ subtotal: totals.subtotal, discount_total: totals.discount, tax_total: totals.tax, total: totals.total, tax_breakdown: totals.breakdown }).eq("id", inv.id);
      }
      setSaving("saved");
    } catch (e) {
      setSaving("error");
      toast.error(errorMessage(e));
    }
  }, [inv, lines, totals]);
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  };
  const setI = (patch: Partial<Invoice>) => {
    if (!editable) return;
    setInv((x) => (x ? { ...x, ...patch } : x));
    dirty.current.inv = true;
    setSaving("saving");
    schedule();
  };
  const setLine = (lid: string, patch: Partial<Line>) => {
    if (!editable) return;
    setLines((ls) => ls.map((l) => (l.id === lid ? { ...l, ...patch } : l)));
    dirty.current.lines = true;
    setSaving("saving");
    schedule();
  };
  const addLine = (patch: Partial<Line> = {}) => {
    if (!inv || !editable) return;
    const tax = settings.taxes.find((t) => t.is_default) ?? settings.taxes[0];
    const l: Line = { id: crypto.randomUUID(), invoice_id: inv.id, position: lines.length + 1, kind: "item", service_id: null, description: "", quantity: 1, unit: "", unit_price: 0, discount_pct: 0, tax_rate_id: tax?.id ?? null, tax_rate: Number(tax?.rate ?? 0), tax_category: tax?.category ?? "S", tax_note: tax?.note ?? "", net: 0, ...patch };
    setLines((ls) => [...ls, l]);
    dirty.current.lines = true;
    schedule();
  };
  const removeLine = (lid: string) => {
    setLines((ls) => ls.filter((l) => l.id !== lid));
    removed.current.push(lid);
    dirty.current.lines = true;
    schedule();
  };
  const moveLine = (from: number, to: number) => {
    if (to < 0 || to >= lines.length) return;
    setLines((ls) => {
      const next = [...ls];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x);
      return next;
    });
    dirty.current.lines = true;
    schedule();
  };
  const setTax = (lid: string, t: TaxRate | undefined) => setLine(lid, { tax_rate_id: t?.id ?? null, tax_rate: Number(t?.rate ?? 0), tax_category: t?.category ?? "S", tax_note: t?.note ?? "" });
  useEffect(() => () => clearTimeout(timer.current), []);

  // ---- live PDF preview
  useEffect(() => {
    if (!shown) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const { renderInvoicePdf } = await import("./InvoicePdf");
        const blob = await renderInvoicePdf({ invoice: shown, lines: shownLines, seller: draft ? sellerOf(profile) : shown.seller, creditFor, draft });
        if (!live) return;
        const url = URL.createObjectURL(blob);
        setPdfUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } catch (e) {
        console.error(e);
      }
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(shown), JSON.stringify(shownLines), profile?.id, creditFor]);

  // Clients of the hub, for "Bill to".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clients = useMemo(() => getDerived().engine.rowIds(clientsTable).map((rid) => ({ id: rid, name: tileTitleText(clientsTable, rid, {}) })), [clientsTable, version]);

  const pickClient = async (rowId: number | null) => {
    if (!inv) return;
    if (!rowId) return setI({ client_row: null });
    const { data } = await supabase().from("invoice_billing").select("*").eq("doc_id", inv.doc_id).eq("client_row", rowId).maybeSingle();
    const name = clients.find((c) => c.id === rowId)?.name ?? "";
    setI({
      client_row: rowId,
      bill_name: data?.name || name,
      bill_address: data?.address ?? "",
      bill_country: data?.country ?? "",
      bill_vat_id: data?.vat_id ?? "",
      bill_email: data?.email ?? "",
      ...(data?.language ? { language: data.language } : {}),
      ...(data?.currency ? { currency: data.currency } : {}),
    });
  };

  const checkVat = async () => {
    if (!inv?.bill_vat_id) return;
    setVat("Checking…");
    const { data, error } = await supabase().functions.invoke("vat-check", { body: { vat: inv.bill_vat_id } });
    if (error) return setVat(`Couldn't check: ${errorMessage(error)}`);
    const r = data as { valid: boolean; name?: string; address?: string; country?: string; error?: string };
    if (r.error) return setVat(r.error);
    if (!r.valid) return setVat("Not a valid EU VAT number (VIES)");
    setVat(`Valid${r.name ? `: ${r.name}` : ""}`);
    if (editable) setI({ ...(r.name && !inv.bill_name ? { bill_name: r.name } : {}), ...(r.address && !inv.bill_address ? { bill_address: r.address } : {}), ...(r.country && !inv.bill_country ? { bill_country: r.country } : {}) });
  };

  // ---- actions
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(null);
  };
  const issue = () =>
    run("Issuing…", async () => {
      if (!inv) return;
      clearTimeout(timer.current);
      dirty.current = { inv: true, lines: true };
      await save();
      const { data: problems, error: pe } = await supabase().rpc("invoice_problems", { p_id: inv.id });
      if (pe) throw pe;
      if ((problems as string[]).length) {
        await confirm({ title: "Not ready to issue yet", message: <ul className="list-disc space-y-1 pl-5">{(problems as string[]).map((p) => <li key={p}>{p}</li>)}</ul>, confirmLabel: "OK" });
        return;
      }
      const series = settings.series.find((s) => s.profile_id === inv.profile_id && s.kind === inv.kind);
      const next = series ? formatNumber(series.pattern, series.yearly && series.year !== new Date(`${inv.issue_date}T00:00:00Z`).getUTCFullYear() ? 1 : series.next_number, inv.issue_date) : "the next number";
      const ok = await confirm({
        title: `Issue this ${KIND_LABEL[inv.kind].toLowerCase()}?`,
        message: `It gets the number ${next} and can't be changed afterwards (mistakes are corrected with a credit note). Total ${money(totals.total, inv.currency)}.`,
        confirmLabel: "Issue",
      });
      if (!ok) return;
      const { error } = await supabase().rpc("invoice_issue", { p_id: inv.id });
      if (error) throw error;
      await storeIssuedFiles(inv.id);
      toast.success("Issued");
      await reload();
    });
  const finishIssue = () => run("Storing the PDF…", async () => (await storeIssuedFiles(id), await reload()));
  const downloadPdf = () =>
    run("Preparing…", async () => {
      if (!inv) return;
      const name = `${inv.number ?? "draft"}.pdf`;
      if (inv.pdf_path) {
        const url = await invoiceFileUrl(inv.pdf_path, name);
        if (url) return void window.open(url, "_blank", "noopener");
      }
      const { renderInvoicePdf } = await import("./InvoicePdf");
      downloadBlob(await renderInvoicePdf({ invoice: shown!, lines: shownLines, seller: draft ? sellerOf(profile) : inv.seller, creditFor, draft }), name);
    });
  const downloadXml = () => run("Preparing…", async () => {
    if (!inv?.xml_path) return;
    const url = await invoiceFileUrl(inv.xml_path, `${inv.number}.xml`);
    if (url) window.open(url, "_blank", "noopener");
  });
  const copyLink = async () => {
    if (!inv?.public_token) return;
    await navigator.clipboard.writeText(`${window.location.origin}/i/${inv.public_token}`).catch(() => undefined);
    toast.success("Link copied");
  };
  const rpcAndGo = (label: string, fn: string, args: Record<string, unknown>) =>
    run(label, async () => {
      const { data, error } = await supabase().rpc(fn, args);
      if (error) throw error;
      if (typeof data === "string") router.push(`/w/${wsId}/invoices/${data}`);
      else await reload();
    });
  const voidIt = async () => {
    const reason = await prompt({ title: "Void this invoice?", label: "Why (kept with the invoice)", confirmLabel: "Void" });
    if (reason) await rpcAndGo("Voiding…", "invoice_void", { p_id: id, p_reason: reason });
  };
  const deleteDraft = async () => {
    if (!(await confirm({ title: "Delete this draft?", message: "It has no number yet, so nothing is lost from the numbering.", confirmLabel: "Delete", danger: true }))) return;
    const { error } = await supabase().from("invoices").delete().eq("id", id);
    if (error) return toast.error(errorMessage(error));
    router.push(`/w/${wsId}/invoices`);
  };
  const makeRecurring = async () => {
    if (!inv) return;
    const every = await prompt({ title: "Repeat this invoice", label: "Every: month, quarter or year", initial: "month", confirmLabel: "Repeat" });
    if (!every || !["month", "quarter", "year"].includes(every.trim())) return;
    const months = { month: 1, quarter: 3, year: 12 }[every.trim() as "month"];
    const d = new Date(`${inv.issue_date}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    const { error } = await supabase().from("invoice_recurring").insert({ doc_id: inv.doc_id, template_id: inv.id, every: every.trim(), next_run: d.toISOString().slice(0, 10) });
    if (error) return toast.error(errorMessage(error));
    toast.success(`A new draft will be made every ${every.trim()} from ${d.toISOString().slice(0, 10)} (Invoices → Recurring).`);
  };

  if (error) return <div className="m-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  if (!inv || !shown) return <div className="flex h-full items-center justify-center text-sm text-gray-500"><Loader2 size={16} className="mr-2 animate-spin" /> Loading…</div>;
  const st = displayStatus(inv);
  const svc = settings.services.filter((s) => s.active && (!svcQuery.trim() || s.name.toLowerCase().includes(svcQuery.toLowerCase())));
  const balance = balanceOf(shown);

  return (
    <div className="flex h-full min-h-0">
      <div className="scroll-thin flex w-[min(640px,52%)] shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white">
        <header className="sticky top-0 z-10 border-b border-gray-100 bg-white px-5 py-3">
          <Link href={`/w/${wsId}/invoices${inv.kind === "quote" ? "?tab=quotes" : ""}`} className="mb-1 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-700">
            <ArrowLeft size={12} /> {inv.kind === "quote" ? "Quotes" : "Invoices"}
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">
              {KIND_LABEL[inv.kind]} {inv.number ?? <span className="font-normal text-gray-400">(draft)</span>}
            </h1>
            <StatusChip label={st.label} tone={st.tone} />
            <div className="flex-1" />
            {draft && <span className="text-xs text-gray-400">{saving === "saving" ? "Saving…" : saving === "error" ? "Not saved" : "Saved"}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {draft && canEdit && (
              <Button size="sm" variant="primary" onClick={() => void issue()} disabled={!!busy}>
                <CheckCircle2 size={13} /> Issue
              </Button>
            )}
            {!draft && !inv.pdf_path && inv.status !== "void" && canEdit && (
              <Button size="sm" variant="primary" onClick={() => void finishIssue()} disabled={!!busy}>
                <RotateCcw size={13} /> Finish issuing (store PDF)
              </Button>
            )}
            {!draft && inv.status !== "void" && canEdit && (
              <Button size="sm" variant={inv.sent_at ? undefined : "primary"} onClick={() => setSendOpen(true)} disabled={!inv.pdf_path}>
                <Send size={13} /> {inv.sent_at ? "Send again" : "Send"}
              </Button>
            )}
            <Button size="sm" onClick={() => void downloadPdf()} disabled={!!busy}>
              <Download size={13} /> PDF
            </Button>
            {inv.xml_path && (
              <Button size="sm" onClick={() => void downloadXml()}>
                <FileCode2 size={13} /> E-invoice XML
              </Button>
            )}
            {inv.public_token && (
              <Button size="sm" onClick={() => void copyLink()}>
                <Link2 size={13} /> Copy link
              </Button>
            )}
            {canEdit && (inv.kind === "invoice" || inv.kind === "proforma") && (inv.status === "issued" || inv.status === "paid") && (
              <Button size="sm" onClick={() => setPayOpen(true)}>
                <Receipt size={13} /> Record payment
              </Button>
            )}
            {canEdit && inv.kind === "quote" && (inv.status === "issued" || inv.status === "accepted") && (
              <Button size="sm" onClick={() => void rpcAndGo("Converting…", "invoice_from_quote", { p_id: id })}>
                <Receipt size={13} /> Turn into invoice
              </Button>
            )}
            {canEdit && inv.kind === "invoice" && (inv.status === "issued" || inv.status === "paid") && (
              <Button size="sm" onClick={() => void rpcAndGo("Creating…", "invoice_credit_note", { p_id: id })}>
                <Undo2 size={13} /> Credit note
              </Button>
            )}
            {canEdit && (
              <Button size="sm" onClick={() => void rpcAndGo("Copying…", "invoice_duplicate", { p_id: id })}>
                <Copy size={13} /> Duplicate
              </Button>
            )}
            {canEdit && inv.kind === "invoice" && inv.status !== "void" && (
              <Button size="sm" onClick={() => void makeRecurring()}>
                <Repeat size={13} /> Repeat
              </Button>
            )}
            {canEdit && !draft && ["issued", "accepted", "declined"].includes(inv.status) && payments.length === 0 && (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => void voidIt()}>
                <Ban size={13} /> Void
              </Button>
            )}
            {canEdit && draft && (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => void deleteDraft()}>
                <Trash2 size={13} /> Delete draft
              </Button>
            )}
            {busy && <span className="flex items-center gap-1 text-xs text-gray-500"><Loader2 size={12} className="animate-spin" /> {busy}</span>}
          </div>
          {inv.status === "void" && <p className="mt-2 rounded bg-gray-100 px-2 py-1 text-xs text-gray-700">Voided: {inv.void_reason}</p>}
        </header>

        <fieldset disabled={!editable} className="space-y-5 px-5 py-4">
          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Select value={inv.profile_id ?? ""} onChange={(e) => setI({ profile_id: e.target.value })}>
                {settings.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Type">
              <Select value={inv.kind} onChange={(e) => setI({ kind: e.target.value as Invoice["kind"] })} disabled={!!inv.credit_of}>
                <option value="invoice">Invoice</option>
                <option value="quote">Quote</option>
                <option value="proforma">Pro forma invoice</option>
                {inv.credit_of && <option value="credit_note">Credit note</option>}
              </Select>
            </Field>
          </section>

          <section className="space-y-2 rounded-lg border border-gray-200 p-3">
            <div className="flex items-center gap-2">
              <Label className="!mb-0">Bill to</Label>
              <Select className="!h-8 flex-1" value={inv.client_row ?? ""} onChange={(e) => void pickClient(Number(e.target.value) || null)}>
                <option value="">Choose a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <Input value={inv.bill_name} onChange={(e) => setI({ bill_name: e.target.value })} placeholder="Company or person" aria-label="Client name" />
            <textarea value={inv.bill_address} onChange={(e) => setI({ bill_address: e.target.value })} rows={2} placeholder="Address" aria-label="Client address" className={clsx(TONE, "w-full")} />
            <div className="grid grid-cols-[5rem_1fr_auto] gap-2">
              <Input value={inv.bill_country} onChange={(e) => setI({ bill_country: e.target.value.toUpperCase().slice(0, 2) })} placeholder="Country" aria-label="Client country" maxLength={2} />
              <Input value={inv.bill_vat_id} onChange={(e) => (setI({ bill_vat_id: e.target.value.toUpperCase().replace(/\s+/g, "") }), setVat(null))} placeholder="VAT number (e.g. DE123456789)" aria-label="Client VAT number" />
              <Button size="sm" onClick={() => void checkVat()} disabled={!inv.bill_vat_id} title="Check with the EU VIES service">
                <Search size={13} /> Check
              </Button>
            </div>
            {vat && <p className={clsx("text-xs", vat.startsWith("Valid") ? "text-emerald-700" : "text-amber-700")}>{vat}</p>}
            <Input value={inv.bill_email} onChange={(e) => setI({ bill_email: e.target.value })} placeholder="Billing email(s), comma separated" aria-label="Billing email" />
            <p className="text-[11px] text-gray-400">Changes here are remembered for this client&apos;s next invoices. Issued invoices keep the details they were issued with.</p>
          </section>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Issue date">
              <input type="date" className={clsx(TONE, "w-full")} value={inv.issue_date} onChange={(e) => setI({ issue_date: e.target.value })} />
            </Field>
            {inv.kind !== "credit_note" && (
              <Field label={inv.kind === "quote" ? "Valid until" : "Due date"}>
                <input type="date" className={clsx(TONE, "w-full")} value={inv.due_date ?? ""} onChange={(e) => setI({ due_date: e.target.value || null })} />
              </Field>
            )}
            {inv.kind !== "credit_note" && inv.kind !== "quote" && (
              <Field label="Payment terms">
                <Select value="" onChange={(e) => e.target.value !== "" && setI({ due_date: addDays(inv.issue_date, Number(e.target.value)) })}>
                  <option value="">Set the due date…</option>
                  {TERMS.map((t) => (
                    <option key={t} value={t}>
                      {t === 0 ? "Due on receipt" : `Net ${t} days`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Supplied from">
              <input type="date" className={clsx(TONE, "w-full")} value={inv.supply_from ?? ""} onChange={(e) => setI({ supply_from: e.target.value || null })} />
            </Field>
            <Field label="Supplied until">
              <input type="date" className={clsx(TONE, "w-full")} value={inv.supply_to ?? ""} onChange={(e) => setI({ supply_to: e.target.value || null })} />
            </Field>
            <Field label="Reference / PO">
              <Input value={inv.reference} onChange={(e) => setI({ reference: e.target.value })} />
            </Field>
            <Field label="Currency">
              <Input value={inv.currency} maxLength={3} onChange={(e) => setI({ currency: e.target.value.toUpperCase().slice(0, 3) })} />
            </Field>
            <Field label="Language">
              <Select value={inv.language} onChange={(e) => setI({ language: e.target.value })}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Design">
              <div className="flex gap-1.5">
                <Select value={inv.template} onChange={(e) => setI({ template: e.target.value as Invoice["template"] })}>
                  <option value="classic">Classic</option>
                  <option value="modern">Modern</option>
                  <option value="minimal">Minimal</option>
                  <option value="bold">Bold</option>
                </Select>
                <input type="color" value={inv.color} onChange={(e) => setI({ color: e.target.value })} className="h-9 w-10 shrink-0 cursor-pointer rounded border border-gray-300" aria-label="Brand colour" />
              </div>
            </Field>
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <Label className="!mb-0">Items</Label>
              <div className="flex-1" />
              {editable && settings.services.length > 0 && (
                <div className="relative">
                  <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input list={`svc-${id}`} value={svcQuery} placeholder="Add a service…" aria-label="Add a service" className="h-7 w-48 rounded border border-gray-300 pl-6 pr-2 text-xs outline-none focus:border-brand-500"
                    onChange={(e) => {
                      const v = e.target.value;
                      const s = settings.services.find((x) => x.name === v);
                      if (s) {
                        const t = settings.taxes.find((x) => x.id === s.tax_rate_id) ?? settings.taxes.find((x) => x.is_default);
                        addLine({ service_id: s.id, description: s.description ? `${s.name}\n${s.description}` : s.name, unit: s.unit, unit_price: Number(s.price), tax_rate_id: t?.id ?? null, tax_rate: Number(t?.rate ?? 0), tax_category: t?.category ?? "S", tax_note: t?.note ?? "" });
                        setSvcQuery("");
                      } else setSvcQuery(v);
                    }}
                  />
                  <datalist id={`svc-${id}`}>
                    {svc.map((s) => (
                      <option key={s.id} value={s.name}>
                        {money(s.price, inv.currency)} / {s.unit}
                      </option>
                    ))}
                  </datalist>
                </div>
              )}
            </div>
            <div className="space-y-2">
              {lines.map((l, i) =>
                l.kind === "heading" ? (
                  <div key={l.id} className="flex items-center gap-1.5">
                    <GripVertical size={14} className="text-gray-300" />
                    <Input value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} placeholder="Section heading" className="font-semibold" />
                    {editable && <LineButtons i={i} n={lines.length} move={moveLine} remove={() => removeLine(l.id)} />}
                  </div>
                ) : (
                  <div key={l.id} className="rounded-md border border-gray-200 p-2">
                    <div className="flex items-start gap-1.5">
                      <textarea value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} rows={Math.min(4, Math.max(1, l.description.split("\n").length))} placeholder="What you did or sold" aria-label="Description" className={clsx(TONE, "min-w-0 flex-1")} />
                      {editable && <LineButtons i={i} n={lines.length} move={moveLine} remove={() => removeLine(l.id)} />}
                    </div>
                    <div className="mt-1.5 grid grid-cols-[4.5rem_4.5rem_6rem_4rem_1fr_auto] items-center gap-1.5">
                      <input type="number" step="any" className={TONE} value={l.quantity} onChange={(e) => setLine(l.id, { quantity: Number(e.target.value) })} aria-label="Quantity" title="Quantity" />
                      <input className={TONE} value={l.unit} onChange={(e) => setLine(l.id, { unit: e.target.value })} placeholder="unit" aria-label="Unit" list="units" />
                      <input type="number" step="any" className={TONE} value={l.unit_price} onChange={(e) => setLine(l.id, { unit_price: Number(e.target.value) })} aria-label="Unit price" title="Unit price" />
                      <input type="number" step="any" min={0} max={100} className={TONE} value={l.discount_pct || ""} placeholder="−%" onChange={(e) => setLine(l.id, { discount_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} aria-label="Discount %" title="Discount %" />
                      <select className={TONE} value={l.tax_rate_id ?? ""} onChange={(e) => setTax(l.id, settings.taxes.find((t) => t.id === e.target.value))} aria-label="Tax">
                        {!l.tax_rate_id && <option value="">{l.tax_rate}% {l.tax_category}</option>}
                        {settings.taxes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <span className="w-24 text-right text-sm font-medium tabular-nums">{money(totals.nets.get(l.id) ?? 0, inv.currency)}</span>
                    </div>
                    {l.tax_category !== "S" && <p className="mt-1 text-[11px] text-gray-500">{CATEGORY_LABEL[l.tax_category]}{l.tax_note ? `: “${l.tax_note}” is printed on the invoice` : ""}</p>}
                  </div>
                ),
              )}
              <datalist id="units">
                {["hour", "day", "piece", "month", "project", "word", "km"].map((u) => <option key={u} value={u} />)}
              </datalist>
            </div>
            {editable && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => addLine()}>
                  <Plus size={13} /> Item
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLine({ kind: "heading", description: "", quantity: 0 })}>
                  <Heading size={13} /> Heading
                </Button>
              </div>
            )}
          </section>

          <section className="ml-auto w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-gray-600">Subtotal</span><span className="tabular-nums">{money(shown.subtotal, inv.currency)}</span></div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-600">Discount on everything</span>
              <span className="flex items-center gap-1">
                <input type="number" min={0} max={100} step="any" value={inv.discount_pct || ""} placeholder="0" onChange={(e) => setI({ discount_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} className="h-7 w-16 rounded border border-gray-300 px-1.5 text-right text-sm" aria-label="Invoice discount %" />%
              </span>
            </div>
            {Number(shown.discount_total) ? <div className="flex justify-between"><span className="text-gray-600">Discount</span><span className="tabular-nums">−{money(shown.discount_total, inv.currency)}</span></div> : null}
            {shown.tax_breakdown.map((b) => (
              <div key={`${b.rate}${b.category}`} className="flex justify-between">
                <span className="text-gray-600">VAT {b.category === "S" ? `${b.rate}%` : CATEGORY_LABEL[b.category]} on {money(b.base, inv.currency)}</span>
                <span className="tabular-nums">{money(b.tax, inv.currency)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-gray-200 pt-1.5 text-base font-semibold"><span>Total</span><span className="tabular-nums">{money(shown.total, inv.currency)}</span></div>
            {!draft && (Number(inv.paid_amount) > 0 || Number(inv.credited_amount) > 0) && (
              <div className="flex justify-between font-medium"><span>Balance due</span><span className="tabular-nums">{money(balance, inv.currency)}</span></div>
            )}
          </section>

          <section className="grid gap-3">
            <Field label="Notes (shown on the invoice)">
              <textarea value={inv.notes} onChange={(e) => setI({ notes: e.target.value })} rows={2} className={clsx(TONE, "w-full")} />
            </Field>
            <Field label="Terms">
              <textarea value={inv.terms} onChange={(e) => setI({ terms: e.target.value })} rows={2} className={clsx(TONE, "w-full")} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={inv.show_qr} onChange={(e) => setI({ show_qr: e.target.checked })} /> Payment QR code (SEPA, EUR invoices with your IBAN)
            </label>
          </section>
        </fieldset>

        {!draft && (
          <section className="space-y-4 border-t border-gray-100 px-5 py-4 text-sm">
            {payments.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Payments</h3>
                <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                  {payments.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="w-24 text-gray-600">{p.paid_on}</span>
                      <span className="flex-1">{p.method}{p.reference ? ` · ${p.reference}` : ""}</span>
                      <span className="font-medium tabular-nums">{money(p.amount, inv.currency)}</span>
                      {canEdit && (
                        <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove this payment" onClick={() => void rpcAndGo("Removing…", "invoice_delete_payment", { p_payment: p.id })}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">History</h3>
              <ul className="space-y-1 text-xs text-gray-600">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="w-36 shrink-0 text-gray-400">{new Date(e.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                    <span>{EVENT_TEXT[e.kind]?.(e.details) ?? e.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </div>

      <div className="min-w-0 flex-1 bg-gray-100">
        {pdfUrl ? <iframe key={pdfUrl} src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`} title="Invoice preview" className="h-full w-full" /> : <div className="flex h-full items-center justify-center text-sm text-gray-500"><Loader2 size={16} className="mr-2 animate-spin" /> Preparing the preview…</div>}
      </div>

      {sendOpen && <SendDialog inv={inv} profileSubject={profile?.email_subject ?? ""} profileBody={profile?.email_body ?? ""} onClose={(sent) => (setSendOpen(false), sent && void reload())} />}
      {payOpen && <PaymentDialog inv={inv} balance={balance} onClose={(done) => (setPayOpen(false), done && void reload())} />}
    </div>
  );
}

const EVENT_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  issued: (d) => `Issued as ${d.number}`,
  queued: (d) => `Email queued to ${(d.to as string[] | undefined)?.join(", ") ?? ""}`,
  sent: (d) => `Email sent to ${(d.to as string[] | undefined)?.join(", ") ?? ""}`,
  reminded: (d) => `Reminder sent (${d.offset} days from the due date)`,
  viewed: () => "Opened by the client (online link)",
  payment: (d) => `Payment of ${d.amount} recorded (${d.method ?? ""})`,
  payment_removed: (d) => `Payment of ${d.amount} removed`,
  credited: () => "Credit note issued",
  voided: (d) => `Voided: ${d.reason}`,
  accepted: () => "Accepted and turned into an invoice",
};

function sellerOf(p: InvoiceSettings["profiles"][number] | undefined) {
  if (!p) return {};
  return { name: p.name, legal_name: p.legal_name || p.name, address: p.address, country: p.country, vat_id: p.vat_id, reg_no: p.reg_no, email: p.email, phone: p.phone, website: p.website, iban: p.iban, bic: p.bic, bank_name: p.bank_name, logo_url: p.logo_url, footer: p.footer, vat_registered: p.vat_registered };
}

function LineButtons({ i, n, move, remove }: { i: number; n: number; move: (a: number, b: number) => void; remove: () => void }) {
  return (
    <span className="flex shrink-0 flex-col">
      <button type="button" className="rounded px-1 text-[10px] text-gray-400 hover:bg-gray-100 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move up">▲</button>
      <button type="button" className="rounded px-1 text-[10px] text-gray-400 hover:bg-gray-100 disabled:opacity-30" disabled={i === n - 1} onClick={() => move(i, i + 1)} title="Move down">▼</button>
      <button type="button" className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600" onClick={remove} title="Remove"><Trash2 size={12} /></button>
    </span>
  );
}

function SendDialog({ inv, profileSubject, profileBody, onClose }: { inv: Invoice; profileSubject: string; profileBody: string; onClose: (sent: boolean) => void }) {
  const [to, setTo] = useState(inv.bill_email);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(profileSubject);
  const [body, setBody] = useState(profileBody);
  const [xml, setXml] = useState(false);
  const [busy, setBusy] = useState(false);
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const send = async () => {
    setBusy(true);
    const { error } = await supabase().rpc("invoice_send", { p_id: inv.id, p_to: split(to), p_cc: split(cc), p_bcc: [], p_subject: subject, p_body: body, p_attach_pdf: true, p_attach_xml: xml });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Queued: it goes out within a minute");
    onClose(true);
  };
  return (
    <Modal open onClose={() => onClose(false)} title={`Send ${inv.number}`} width={560}
      footer={<><Button onClick={() => onClose(false)}>Cancel</Button><Button variant="primary" onClick={() => void send()} disabled={busy || !split(to).length}><Mail size={14} /> {busy ? "Sending…" : "Send"}</Button></>}>
      <div className="space-y-3">
        <Field label="To"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@example.com" /></Field>
        <Field label="CC"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message"><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={clsx(TONE, "w-full")} /></Field>
        <p className="text-xs text-gray-500">Placeholders: {"{{number}} {{client}} {{total}} {{balance}} {{due_date}} {{issue_date}} {{company}} {{link}}"} (the online invoice). The PDF is attached.</p>
        {inv.xml_path && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={xml} onChange={(e) => setXml(e.target.checked)} /> Also attach the e-invoice (UBL XML)</label>}
      </div>
    </Modal>
  );
}

function PaymentDialog({ inv, balance, onClose }: { inv: Invoice; balance: number; onClose: (done: boolean) => void }) {
  const [amount, setAmount] = useState(String(balance > 0 ? balance : ""));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("bank transfer");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase().rpc("invoice_record_payment", { p_id: inv.id, p_date: date, p_amount: Number(amount), p_method: method, p_reference: reference, p_note: "" });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    onClose(true);
  };
  return (
    <Modal open onClose={() => onClose(false)} title={`Payment for ${inv.number}`} width={420}
      footer={<><Button onClick={() => onClose(false)}>Cancel</Button><Button variant="primary" onClick={() => void save()} disabled={busy || !Number(amount)}>{busy ? "Saving…" : "Record payment"}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Amount (${inv.currency})`}><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{["bank transfer", "card", "cash", "PayPal", "Stripe", "other"].map((m) => <option key={m}>{m}</option>)}</Select></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <p className="col-span-2 text-xs text-gray-500">Balance due: {money(balance, inv.currency)}</p>
      </div>
    </Modal>
  );
}
