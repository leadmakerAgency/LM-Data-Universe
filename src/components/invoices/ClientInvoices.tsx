"use client";

// A client's invoices (on the client's page) and the invoice tiles on the
// workspace Overview.
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui";
import { createDraft, loadSettings } from "@/lib/invoiceData";
import { errorMessage } from "@/lib/supabase";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { InvoiceTable, invoiceSummary, loadInvoiceList, moneyList, type ListedInvoice } from "./InvoicesSection";

function useInvoices(docId: string | null, clientRow?: number | null) {
  const [list, setList] = useState<ListedInvoice[] | null>(null);
  useEffect(() => {
    if (!docId) return;
    let live = true;
    // Before the invoices migration (or without access) this just shows nothing.
    loadInvoiceList(docId, clientRow).then(
      (l) => live && setList(l),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [docId, clientRow]);
  return list;
}

export function ClientInvoices({ wsId, rowId, clientName }: { wsId: string; rowId: number; clientName: string }) {
  const docId = useDoc((s) => s.docId);
  const role = useDoc((s) => s.role);
  const router = useRouter();
  const list = useInvoices(docId, rowId);
  const sum = useMemo(() => invoiceSummary(list ?? []), [list]);
  const [busy, setBusy] = useState(false);
  const create = async (kind: "invoice" | "quote") => {
    if (!docId) return;
    setBusy(true);
    try {
      const s = await loadSettings(docId);
      const id = await createDraft(docId, s, { kind, clientRow: rowId, clientName });
      router.push(`/w/${wsId}/invoices/${id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  if (!list) return <p className="p-5 text-sm text-gray-500">Loading…</p>;
  return (
    <div className="scroll-thin h-full overflow-auto p-5">
      <div className="mb-4 flex flex-wrap items-center gap-6">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Outstanding</div>
          <div className="text-lg font-semibold tabular-nums">{moneyList(sum.outstanding)}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Overdue</div>
          <div className={sum.overdueCount ? "text-lg font-semibold tabular-nums text-red-600" : "text-lg font-semibold tabular-nums"}>{moneyList(sum.overdue)}</div>
        </div>
        <div className="flex-1" />
        {(role === "owner" || role === "editor") && (
          <>
            <Button onClick={() => void create("quote")} disabled={busy}>
              <Plus size={14} /> Quote
            </Button>
            <Button variant="primary" onClick={() => void create("invoice")} disabled={busy}>
              <Plus size={14} /> Invoice for {clientName}
            </Button>
          </>
        )}
      </div>
      {list.length ? (
        <InvoiceTable list={list} wsId={wsId} compact />
      ) : (
        <p className="rounded-md border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">No invoices or quotes for {clientName} yet.</p>
      )}
    </div>
  );
}

export function OverviewInvoiceTiles({ wsId, client }: { wsId: string; client: number | null }) {
  const docId = useDoc((s) => s.docId);
  const list = useInvoices(docId, client);
  const sum = useMemo(() => invoiceSummary(list ?? []), [list]);
  if (!list || !list.length) return null;
  const tile = "rounded-lg border border-gray-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm";
  return (
    <>
      <Link href={`/w/${wsId}/invoices${client ? `?client=${client}` : ""}`} className={tile}>
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Outstanding invoices</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{moneyList(sum.outstanding)}</div>
        <div className="mt-0.5 text-xs text-gray-500">sent and unpaid</div>
      </Link>
      <Link href={`/w/${wsId}/invoices${client ? `?client=${client}` : ""}`} className={tile}>
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Overdue invoices</div>
        <div className={sum.overdueCount ? "mt-1 text-2xl font-semibold tabular-nums text-red-600" : "mt-1 text-2xl font-semibold tabular-nums text-gray-900"}>{moneyList(sum.overdue)}</div>
        <div className="mt-0.5 text-xs text-gray-500">{sum.overdueCount ? `${sum.overdueCount} overdue` : "Nothing overdue"}</div>
      </Link>
    </>
  );
}
