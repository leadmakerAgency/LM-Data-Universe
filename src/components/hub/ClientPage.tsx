"use client";

// A client's own page: key facts, then everything that belongs to the client,
// each tab being the section's first view narrowed to this client.
import clsx from "clsx";
import { ArrowLeft, FilePlus2, FileText, Link2, Unlink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button, Select } from "@/components/ui";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BLANK_DOC } from "@/lib/templates";
import { createDocument } from "@/lib/docBuilder";
import { clientColumn, type HubConfig } from "@/lib/hub";
import { errorMessage, supabase } from "@/lib/supabase";
import type { DocWidget, DocumentRec, WidgetOptions } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { Activity } from "../doc/RecordCard";
import { FieldInput } from "../doc/FieldInput";
import { tileTitleText } from "../doc/RecordTile";
import { WidgetBody } from "../doc/WidgetFrame";

type Tab = string;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="truncate text-lg font-semibold tabular-nums">{value || "—"}</div>
    </div>
  );
}

export function ClientPage({ wsId, config, rowId }: { wsId: string; config: HubConfig; rowId: number }) {
  const router = useRouter();
  const role = useDoc((s) => s.role);
  const widgets = useDoc((s) => s.widgets);
  const exists = useDoc((s) => !!s.rows.get(config.clients)?.has(rowId));
  useDoc((s) => s.version);
  const canEdit = role === "owner" || role === "editor";
  const [tab, setTab] = useState<Tab>("details");
  const [docs, setDocs] = useState<DocumentRec[]>([]);
  const [overrides, setOverrides] = useState<Record<string, WidgetOptions>>({});
  const [linking, setLinking] = useState("");

  const loadDocs = async () => {
    const { data } = await supabase().from("documents").select("*").eq("workspace_id", wsId).eq("kind", "document").is("deleted_at", null).order("updated_at", { ascending: false });
    setDocs((data as DocumentRec[] | null) ?? []);
  };
  useEffect(() => {
    const t = setTimeout(() => void loadDocs(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  // Sections whose table points at Clients become tabs, plus Contacts.
  const tabs = useMemo(() => {
    const out: { key: string; label: string; table: string; widget?: DocWidget }[] = [];
    for (const s of config.sections) {
      if (s.hidden || s.key === "clients" || !clientColumn(tableColumns(s.table), config.clients)) continue;
      const first = [...widgets.values()].filter((w) => w.page_id === s.page).sort((a, b) => a.position - b.position)[0];
      out.push({ key: s.key, label: s.label, table: s.table, widget: first });
    }
    if (config.contacts && clientColumn(tableColumns(config.contacts), config.clients)) out.push({ key: "contacts", label: "Contacts", table: config.contacts });
    return out;
     
  }, [config, widgets]);

  if (!exists) {
    return (
      <div className="p-8 text-sm text-gray-500">
        This client doesn&apos;t exist any more.{" "}
        <Link href={`/w/${wsId}/clients`} className="text-brand-700 hover:underline">
          All clients
        </Link>
      </div>
    );
  }

  const name = tileTitleText(config.clients, rowId, {});
  const cols = tableColumns(config.clients);
  const fact = (label: string) => {
    const c = cols.find((x) => x.label === label);
    return c ? tileTitleText(config.clients, rowId, { tileTitle: c.id }).replace(/^#\d+$/, "") : "";
  };
  const linked = docs.filter((d) => d.hub_client === rowId);
  const others = docs.filter((d) => d.hub_client !== rowId);

  const view = (t: (typeof tabs)[number]): DocWidget => {
    const col = clientColumn(tableColumns(t.table), config.clients)!;
    const base: DocWidget = t.widget ?? { id: `client-${t.key}`, doc_id: "", page_id: "", table_ref: t.table, type: "table", title: t.label, position: 0, width: 12, height: 500, options: {}, link_source: null, link_col: null };
    return { ...base, id: `client-${t.key}`, options: { ...base.options, ...(overrides[t.key] ?? {}), onlyRef: { col: col.id, id: rowId } } };
  };

  const setDocClient = async (docId: string, client: number | null) => {
    const { error } = await supabase().from("documents").update({ hub_client: client }).eq("id", docId);
    if (error) toast.error(errorMessage(error));
    void loadDocs();
  };
  const newDoc = async () => {
    try {
      const id = await createDocument(wsId, { ...BLANK_DOC, name: `${name} – data` });
      await supabase().from("documents").update({ hub_client: rowId }).eq("id", id);
      router.push(`/doc/${id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const current = tabs.find((t) => t.key === tab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-gray-200 bg-white px-5 pt-4">
        <Link href={`/w/${wsId}/clients`} className="mb-1 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-700">
          <ArrowLeft size={12} /> All clients
        </Link>
        <h1 className="text-2xl font-semibold">{name}</h1>
        <div className="mt-3 grid max-w-4xl grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Status" value={fact("Status")} />
          <Fact label="Open value" value={fact("Open value")} />
          <Fact label="Won" value={fact("Won value")} />
          <Fact label="Open tasks" value={fact("Open tasks")} />
          <Fact label="Overdue" value={fact("Overdue tasks")} />
          <Fact label="Files" value={fact("Files")} />
        </div>
        <div className="mt-3 flex gap-1 overflow-x-auto" role="tablist">
          {[{ key: "details", label: "Details" }, ...tabs, { key: "documents", label: `Documents${linked.length ? ` ${linked.length}` : ""}` }, ...(canEdit ? [{ key: "activity", label: "Activity" }] : [])].map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={clsx("-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm", tab === t.key ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 bg-white">
        {tab === "details" && (
          <div className="scroll-thin h-full overflow-auto p-5">
            <div className="grid max-w-4xl gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {cols.map((c) => (
                <div key={c.id} className={clsx(c.options.textFormat === "markdown" && "sm:col-span-2 lg:col-span-3")}>
                  <FieldInput col={c} rowId={rowId} canEdit={canEdit} />
                </div>
              ))}
            </div>
          </div>
        )}
        {current && (
          <ErrorBoundary label="This list couldn't be displayed">
            <WidgetBody key={current.key} widget={view(current)} setOptions={(o) => setOverrides((m) => ({ ...m, [current.key]: { ...(m[current.key] ?? {}), ...o } }))} />
          </ErrorBoundary>
        )}
        {tab === "documents" && (
          <div className="scroll-thin h-full max-w-3xl overflow-auto p-5">
            <p className="mb-3 text-sm text-gray-600">Spreadsheets and data documents that belong to {name}.</p>
            {linked.length === 0 ? (
              <p className="mb-4 rounded-md border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">No documents yet.</p>
            ) : (
              <ul className="mb-4 divide-y divide-gray-100 rounded-md border border-gray-200">
                {linked.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                    <FileText size={15} className="text-gray-400" />
                    <Link href={`/doc/${d.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-brand-700">
                      {d.name}
                    </Link>
                    {canEdit && (
                      <button className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="No longer belongs to this client" onClick={() => void setDocClient(d.id, null)}>
                        <Unlink size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void newDoc()}>
                  <FilePlus2 size={14} /> New document for {name}
                </Button>
                {others.length > 0 && (
                  <>
                    <Select value={linking} onChange={(e) => setLinking(e.target.value)} className="!w-64" aria-label="Document">
                      <option value="">Link an existing document…</option>
                      {others.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                    <Button disabled={!linking} onClick={() => (void setDocClient(linking, rowId), setLinking(""))}>
                      <Link2 size={14} /> Link
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {tab === "activity" && (
          <div className="scroll-thin h-full max-w-4xl overflow-auto p-5">
            <Activity tableRef={config.clients} rowId={rowId} />
          </div>
        )}
      </div>
    </div>
  );
}
