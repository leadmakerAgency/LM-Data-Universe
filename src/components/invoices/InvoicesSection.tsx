"use client";

// The workspace's Invoices section: money owed at a glance, the list of
// invoices / quotes (filter by client, status, search; CSV export), recurring
// schedules, the services catalogue and the invoicing settings.
import clsx from "clsx";
import { Download, FileText, Loader2, Plus, Receipt, Repeat, Settings2, Tags } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Label, Select } from "@/components/ui";
import type { HubConfig } from "@/lib/hub";
import { EU, LANGUAGES, balanceOf, displayStatus, money, type Invoice } from "@/lib/invoices";
import { createDraft, loadSettings, setUpInvoicing, type InvoiceSettings } from "@/lib/invoiceData";
import { errorMessage, supabase } from "@/lib/supabase";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { ClientPicker } from "../hub/ClientPicker";
import { InvoiceEditor } from "./InvoiceEditor";
import { RecurringList, ServicesEditor, SettingsView } from "./InvoiceSettings";

const TONES = {
  gray: "bg-gray-100 text-gray-700",
  blue: "bg-blue-50 text-blue-700",
  amber: "bg-amber-50 text-amber-800",
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-red-50 text-red-700",
} as const;

export function StatusChip({ label, tone }: { label: string; tone: keyof typeof TONES }) {
  return <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", TONES[tone])}>{label}</span>;
}

export type ListedInvoice = Pick<
  Invoice,
  "id" | "kind" | "status" | "number" | "client_row" | "bill_name" | "issue_date" | "due_date" | "currency" | "total" | "tax_total" | "paid_amount" | "credited_amount" | "sent_at" | "viewed_at" | "paid_at" | "created_at"
>;
const LIST_COLS = "id,kind,status,number,client_row,bill_name,issue_date,due_date,currency,total,tax_total,paid_amount,credited_amount,sent_at,viewed_at,paid_at,created_at";

export async function loadInvoiceList(docId: string, clientRow?: number | null): Promise<ListedInvoice[]> {
  let q = supabase().from("invoices").select(LIST_COLS).eq("doc_id", docId).order("issue_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000);
  if (clientRow) q = q.eq("client_row", clientRow);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as ListedInvoice[] | null) ?? []).map((i) => ({ ...i, total: Number(i.total), tax_total: Number(i.tax_total), paid_amount: Number(i.paid_amount), credited_amount: Number(i.credited_amount) }));
}

/** Outstanding / overdue / paid this month / drafts, per currency. */
export function invoiceSummary(list: ListedInvoice[], today = new Date()) {
  const t = today.toISOString().slice(0, 10);
  const month = t.slice(0, 7);
  const add = (m: Map<string, number>, c: string, n: number) => m.set(c, (m.get(c) ?? 0) + n);
  const outstanding = new Map<string, number>();
  const overdue = new Map<string, number>();
  const paid = new Map<string, number>();
  let overdueCount = 0;
  let drafts = 0;
  const aging = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 };
  for (const i of list) {
    if (i.status === "draft") drafts++;
    if (i.kind !== "invoice") continue;
    if (i.status === "paid" && (i.paid_at ?? "").slice(0, 7) === month) add(paid, i.currency, i.total);
    if (i.status !== "issued") continue;
    const bal = balanceOf(i);
    if (bal <= 0) continue;
    add(outstanding, i.currency, bal);
    if (i.due_date && i.due_date < t) {
      overdueCount++;
      add(overdue, i.currency, bal);
      const days = Math.floor((Date.parse(t) - Date.parse(i.due_date)) / 86400000);
      if (days <= 30) aging.d30 += bal;
      else if (days <= 60) aging.d60 += bal;
      else if (days <= 90) aging.d90 += bal;
      else aging.older += bal;
    } else aging.current += bal;
  }
  return { outstanding, overdue, overdueCount, paid, drafts, aging };
}

export const moneyList = (m: Map<string, number>) => (m.size ? [...m].map(([c, n]) => money(n, c)).join(" · ") : money(0, "EUR"));

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "red" | "green" }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={clsx("mt-1 text-lg font-semibold tabular-nums", tone === "red" && "text-red-600", tone === "green" && "text-emerald-700")}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function csv(list: ListedInvoice[], clientName: (id: number | null, fallback: string) => string) {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Type", "Number", "Status", "Client", "Issue date", "Due date", "Currency", "Net", "VAT", "Total", "Paid", "Credited", "Balance"]];
  for (const i of list) {
    rows.push([i.kind, i.number ?? "", displayStatus(i).label, clientName(i.client_row, i.bill_name), i.issue_date, i.due_date ?? "", i.currency, (i.total - i.tax_total).toFixed(2), i.tax_total.toFixed(2), i.total.toFixed(2), i.paid_amount.toFixed(2), i.credited_amount.toFixed(2), balanceOf(i).toFixed(2)].map(String));
  }
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

function SetUp({ docId, onDone }: { docId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("SI");
  const [currency, setCurrency] = useState("EUR");
  const [language, setLanguage] = useState("en");
  const [vat, setVat] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await setUpInvoicing(docId, { name: name.trim(), country, currency, vatRegistered: vat, language });
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-lg p-8">
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <Receipt className="mb-2 text-brand-600" />
        <h2 className="text-lg font-semibold">Set up invoicing</h2>
        <p className="mb-5 text-sm text-gray-600">A few details to start with. Your address, bank account, logo, numbering and email texts are in Settings afterwards.</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Business name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Leadmaker d.o.o." />
          </div>
          <div>
            <Label>Country</Label>
            <Input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="SI" />
          </div>
          <div>
            <Label>Currency</Label>
            <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
          </div>
          <div>
            <Label>Invoice language</Label>
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} /> VAT registered
          </label>
          <p className="col-span-2 text-xs text-gray-500">
            {EU.includes(country) ? `The ${country} VAT rates, reverse charge (EU B2B) and export rates are added for you.` : "Common tax rates are added; adjust them in Settings."}
          </p>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => void go()} disabled={busy || !name.trim() || !/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)}>
            {busy ? "Setting up…" : "Start invoicing"}
          </Button>
        </div>
      </div>
    </div>
  );
}

type Tab = "invoices" | "quotes" | "recurring" | "services" | "settings";
const TABS: { key: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "quotes", label: "Quotes", icon: FileText },
  { key: "recurring", label: "Recurring", icon: Repeat },
  { key: "services", label: "Services", icon: Tags },
  { key: "settings", label: "Settings", icon: Settings2 },
];

export function InvoicesSection({ wsId, config, invoiceId, client, setClient }: { wsId: string; config: HubConfig; invoiceId: string | null; client: number | null; setClient: (id: number | null) => void }) {
  const docId = useDoc((s) => s.docId)!;
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get("tab") as Tab | null) ?? "invoices";
  const [settings, setSettings] = useState<InvoiceSettings | null>(null);
  const [list, setList] = useState<ListedInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const reloadSettings = useCallback(async () => {
    try {
      setSettings(await loadSettings(docId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [docId]);
  const reloadList = useCallback(async () => {
    try {
      setList(await loadInvoiceList(docId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [docId]);
  useEffect(() => {
    const t = setTimeout(() => void reloadSettings(), 0);
    return () => clearTimeout(t);
  }, [reloadSettings]);
  useEffect(() => {
    if (invoiceId) return;
    const t = setTimeout(() => void reloadList(), 0);
    return () => clearTimeout(t);
  }, [reloadList, invoiceId]);

  const setTab = (t: Tab) => router.replace(`/w/${wsId}/invoices${t === "invoices" ? "" : `?tab=${t}`}`, { scroll: false });
  const create = async (kind: Invoice["kind"]) => {
    if (!settings) return;
    setCreating(true);
    try {
      const id = await createDraft(docId, settings, { kind, clientRow: client });
      router.push(`/w/${wsId}/invoices/${id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setCreating(false);
    }
  };

  const shown = useMemo(() => {
    if (!list) return [];
    const term = q.trim().toLowerCase();
    const t = new Date().toISOString().slice(0, 10);
    return list.filter((i) => {
      if (tab === "quotes" ? i.kind !== "quote" : i.kind === "quote") return false;
      if (client && i.client_row !== client) return false;
      if (term && !`${i.number ?? ""} ${i.bill_name}`.toLowerCase().includes(term)) return false;
      if (status === "all") return true;
      if (status === "overdue") return i.status === "issued" && !!i.due_date && i.due_date < t && balanceOf(i) > 0;
      if (status === "open") return i.status === "issued" && balanceOf(i) > 0;
      return i.status === status;
    });
  }, [list, tab, client, q, status]);
  const summary = useMemo(() => invoiceSummary((list ?? []).filter((i) => !client || i.client_row === client)), [list, client]);

  if (error) return <div className="m-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  if (!settings) return <div className="flex h-full items-center justify-center text-sm text-gray-500"><Loader2 size={16} className="mr-2 animate-spin" /> Loading…</div>;
  if (!settings.profiles.length) {
    if (role === "owner") return <SetUp docId={docId} onDone={() => void reloadSettings()} />;
    return <div className="p-8 text-sm text-gray-600">Invoicing isn&apos;t set up in this workspace yet. Ask a workspace owner to open Invoices and set it up.</div>;
  }
  if (invoiceId) return <InvoiceEditor key={invoiceId} id={invoiceId} wsId={wsId} settings={settings} clientsTable={config.clients} />;

  const exportCsv = () => {
    const blob = new Blob([csv(shown, (_id, f) => f)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-gray-200 bg-white px-6 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">Invoices</h1>
          <div className="ml-3">
            <ClientPicker clientsTable={config.clients} col={undefined} value={client} onChange={setClient} />
          </div>
          <div className="flex-1" />
          {canEdit && (
            <>
              <Button onClick={() => void create("quote")} disabled={creating}>
                <Plus size={14} /> Quote
              </Button>
              <Button variant="primary" onClick={() => void create("invoice")} disabled={creating}>
                <Plus size={14} /> Invoice
              </Button>
            </>
          )}
        </div>
        <nav className="mt-3 flex gap-1" aria-label="Invoice tabs">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={clsx("flex items-center gap-1.5 border-b-2 px-3 pb-2 text-sm", tab === t.key ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900")}>
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-6">
        {tab === "settings" ? (
          <SettingsView docId={docId} settings={settings} canEdit={role === "owner"} onChange={() => void reloadSettings()} />
        ) : tab === "services" ? (
          <ServicesEditor docId={docId} settings={settings} canEdit={canEdit} onChange={() => void reloadSettings()} />
        ) : tab === "recurring" ? (
          <RecurringList docId={docId} wsId={wsId} canEdit={canEdit} />
        ) : (
          <>
            {tab === "invoices" && (
              <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile label="Outstanding" value={moneyList(summary.outstanding)} />
                <Tile label="Overdue" value={moneyList(summary.overdue)} sub={summary.overdueCount ? `${summary.overdueCount} invoice${summary.overdueCount === 1 ? "" : "s"}` : "Nothing overdue"} tone={summary.overdueCount ? "red" : undefined} />
                <Tile label="Paid this month" value={moneyList(summary.paid)} tone="green" />
                <Tile label="Drafts" value={String(summary.drafts)} sub="Not issued yet" />
              </div>
            )}
            {tab === "invoices" && summary.overdueCount > 0 && (
              <p className="-mt-2 mb-4 text-xs text-gray-500">
                Overdue by age: up to 30 days {summary.aging.d30.toFixed(2)} · 31–60 days {summary.aging.d60.toFixed(2)} · 61–90 days {summary.aging.d90.toFixed(2)} · older {summary.aging.older.toFixed(2)}
              </p>
            )}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or client" className="!h-8 max-w-60" aria-label="Search invoices" />
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!h-8 max-w-44" aria-label="Status">
                <option value="all">All statuses</option>
                <option value="draft">Drafts</option>
                {tab === "invoices" ? (
                  <>
                    <option value="open">Unpaid</option>
                    <option value="overdue">Overdue</option>
                    <option value="paid">Paid</option>
                  </>
                ) : (
                  <>
                    <option value="issued">Sent</option>
                    <option value="accepted">Accepted</option>
                  </>
                )}
                <option value="void">Void</option>
              </Select>
              <div className="flex-1" />
              <Button size="sm" onClick={exportCsv} disabled={!shown.length}>
                <Download size={13} /> CSV
              </Button>
            </div>
            {!list ? (
              <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
            ) : !shown.length ? (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
                {list.length ? "Nothing matches." : tab === "quotes" ? "No quotes yet." : "No invoices yet. Create the first one with “+ Invoice”."}
              </div>
            ) : (
              <InvoiceTable list={shown} wsId={wsId} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function InvoiceTable({ list, wsId, compact }: { list: ListedInvoice[]; wsId: string; compact?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Number</th>
            {!compact && <th className="px-3 py-2 font-medium">Client</th>}
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Due</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
            <th className="px-3 py-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {list.map((i) => {
            const st = displayStatus(i);
            const href = `/w/${wsId}/invoices/${i.id}`;
            return (
              <tr key={i.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <Link href={href} className="font-medium text-brand-700 hover:underline">
                    {i.number ?? "Draft"}
                  </Link>
                  {i.kind === "credit_note" && <span className="ml-1.5 text-[11px] text-gray-500">credit note</span>}
                  {i.kind === "proforma" && <span className="ml-1.5 text-[11px] text-gray-500">pro forma</span>}
                </td>
                {!compact && <td className="max-w-64 truncate px-3 py-2">{i.bill_name || <span className="text-gray-400">No client</span>}</td>}
                <td className="whitespace-nowrap px-3 py-2 text-gray-600">{i.issue_date}</td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-600">{i.due_date ?? ""}</td>
                <td className="px-3 py-2">
                  <StatusChip label={st.label} tone={st.tone} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(i.total, i.currency)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-600">{i.status === "issued" ? money(balanceOf(i), i.currency) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
