"use client";

// Integrations (owners): webhooks, automations, their delivery log, and how to
// reach this document through the REST API.
import clsx from "clsx";
import { Copy, Mail, Play, Plus, RefreshCw, RotateCcw, Trash2, Webhook, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AclConditionError, compileCondition, type AclSchema } from "@engine/acl";
import { Button, Input, Select, Spinner, useDialogs } from "@/components/ui";
import { ConditionInput } from "./AccessRules";
import { EmailActionEditor, EmailStatusBanner, emailProblem, type EmailAction, type EmailStatus } from "./EmailAction";
import { errorMessage, supabase } from "@/lib/supabase";
import { tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

interface WebhookRec {
  id?: string;
  table_ref: string;
  name: string;
  url: string;
  events: ("add" | "update")[];
  ready_col: string | null;
  enabled: boolean;
  secret?: string;
}

type AutomationAction = EmailAction | { type: "webhook"; url: string };

interface AutomationRec {
  id?: string;
  table_ref: string;
  name: string;
  enabled: boolean;
  trigger: "add" | "update" | "add_or_update";
  watch_cols: string[];
  condition: string;
  actions: AutomationAction[];
  secret?: string;
}

interface JobRec {
  id: number;
  kind: "webhook" | "automation";
  source_id: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  created_at: string;
  finished_at: string | null;
  last_status: number | null;
  last_error: string | null;
  /** Emails only: where the message is, as far as SendGrid has told us. */
  delivery: "queued" | "sent" | "delivered" | "deferred" | "bounced" | "blocked" | "spam" | "failed" | null;
  row_ids: (number | null)[];
  action_index: number | null;
  event: string | null;
}

interface Data {
  webhooks: WebhookRec[];
  automations: AutomationRec[];
  jobs: JobRec[];
  queued: number;
}

const STATUS_STYLE: Record<JobRec["status"], string> = {
  pending: "bg-amber-50 text-amber-800",
  running: "bg-sky-50 text-sky-800",
  done: "bg-emerald-50 text-emerald-800",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-gray-100 text-gray-600",
};
const STATUS_LABEL: Record<JobRec["status"], string> = {
  pending: "Waiting",
  running: "Sending",
  done: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
};

// What SendGrid reported for an email after accepting it.
const DELIVERY_LABEL: Record<NonNullable<JobRec["delivery"]>, string> = {
  queued: "",
  sent: "Accepted",
  delivered: "Reached the inbox",
  deferred: "Delayed by the recipient's server",
  bounced: "Bounced",
  blocked: "Blocked",
  spam: "Marked as spam",
  failed: "",
};
const DELIVERY_BAD = new Set(["bounced", "blocked", "spam"]);

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function IntegrationsView() {
  const docId = useDoc((s) => s.docId);
  const tables = useDoc((s) => s.tables);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mail, setMail] = useState<EmailStatus | null>(null);
  const [editing, setEditing] = useState<{ kind: "webhook"; rec: WebhookRec } | { kind: "automation"; rec: AutomationRec } | null>(null);
  const sortedTables = useMemo(() => [...tables.values()].sort((a, b) => a.position - b.position), [tables]);

  const load = useCallback(async () => {
    if (!docId) return;
    const { data, error } = await supabase().rpc("get_integrations", { p_doc: docId });
    if (error) setError(errorMessage(error));
    else {
      setError(null);
      setData(data as Data);
    }
  }, [docId]);

  // Whether email is set up (it changes rarely: asked once per visit).
  useEffect(() => {
    void supabase()
      .rpc("email_status")
      .then(({ data }) => setMail((data as EmailStatus | null) ?? null));
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 8000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  if (error) return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  if (!data || !docId) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const firstTable = sortedTables[0]?.id ?? "";
  const nameOf = (j: JobRec) =>
    j.kind === "webhook"
      ? (data.webhooks.find((w) => w.id === j.source_id)?.name || "Webhook")
      : (data.automations.find((a) => a.id === j.source_id)?.name || "Automation");
  const actionOf = (j: JobRec) => {
    if (j.kind === "webhook") return "webhook";
    const a = data.automations.find((x) => x.id === j.source_id)?.actions[j.action_index ?? 0];
    return a ? (a.type === "email" ? "email" : "webhook") : "";
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-gray-600">
          Send changes to other services as they happen, and act on them automatically. Only owners see this page. Webhooks and automations read records as the
          person who set them up.
        </p>
      </div>

      {(editing?.kind === "automation" || data.automations.some((a) => a.actions.some((x) => x.type === "email"))) && <EmailStatusBanner status={mail} />}

      <ApiBox docId={docId} tableName={sortedTables[0]?.table_id ?? "Table1"} />

      {editing?.kind === "webhook" ? (
        <WebhookEditor
          rec={editing.rec}
          docId={docId}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : editing?.kind === "automation" ? (
        <AutomationEditor
          rec={editing.rec}
          docId={docId}
          mail={mail}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : (
        <>
          <section className="rounded-lg border border-gray-200 bg-white">
            <header className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
              <Webhook size={16} className="text-gray-400" />
              <h2 className="text-sm font-semibold">Webhooks</h2>
              <span className="text-xs text-gray-500">Post added and changed records to a URL</span>
              <div className="flex-1" />
              <Button
                size="sm"
                disabled={!firstTable}
                onClick={() => setEditing({ kind: "webhook", rec: { table_ref: firstTable, name: "", url: "", events: ["add", "update"], ready_col: null, enabled: true } })}
              >
                <Plus size={13} /> Webhook
              </Button>
            </header>
            {data.webhooks.length === 0 ? (
              <p className="px-4 py-5 text-sm text-gray-500">No webhooks yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.webhooks.map((w) => (
                  <li key={w.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className={clsx("h-2 w-2 shrink-0 rounded-full", w.enabled ? "bg-emerald-500" : "bg-gray-300")} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "webhook", rec: w })}>
                      <div className="truncate font-medium">{w.name || w.url}</div>
                      <div className="truncate text-xs text-gray-500">
                        {tables.get(w.table_ref)?.table_id} · {w.events.map((e) => (e === "add" ? "added" : "changed")).join(" and ")} records · {w.url}
                      </div>
                    </button>
                    <TestButton kind="webhook" id={w.id!} onDone={load} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white">
            <header className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
              <Zap size={16} className="text-gray-400" />
              <h2 className="text-sm font-semibold">Automations</h2>
              <span className="text-xs text-gray-500">When a record is added or changes, send an email or call a webhook</span>
              <div className="flex-1" />
              <Button
                size="sm"
                disabled={!firstTable}
                onClick={() =>
                  setEditing({
                    kind: "automation",
                    rec: {
                      table_ref: firstTable,
                      name: "",
                      enabled: true,
                      trigger: "add_or_update",
                      watch_cols: [],
                      condition: "",
                      actions: [{ type: "email", to: "", subject: "", body: "" }],
                    },
                  })
                }
              >
                <Plus size={13} /> Automation
              </Button>
            </header>
            {data.automations.length === 0 ? (
              <p className="px-4 py-5 text-sm text-gray-500">No automations yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.automations.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className={clsx("h-2 w-2 shrink-0 rounded-full", a.enabled ? "bg-emerald-500" : "bg-gray-300")} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "automation", rec: a })}>
                      <div className="truncate font-medium">{a.name || "Untitled automation"}</div>
                      <div className="truncate text-xs text-gray-500">
                        {triggerText(a, tables.get(a.table_ref)?.table_id ?? "?")}
                        {a.condition ? ` · if ${a.condition}` : ""} · {a.actions.map((x) => (x.type === "email" ? "email" : "webhook")).join(", ")}
                      </div>
                    </button>
                    <TestButton kind="automation" id={a.id!} onDone={load} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="rounded-lg border border-gray-200 bg-white">
        <header className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold">Deliveries</h2>
          <span className="text-xs text-gray-500">
            {data.queued ? `${data.queued} waiting · ` : ""}the last 100; failed ones are retried with growing waits
          </span>
          <div className="flex-1" />
          <button className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Refresh" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
        </header>
        {data.jobs.length === 0 ? (
          <p className="px-4 py-5 text-sm text-gray-500">Nothing sent yet.</p>
        ) : (
          <div className="scroll-thin max-h-[420px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">What</th>
                  <th className="px-2 py-2 font-medium">Records</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">Details</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="whitespace-nowrap px-4 py-1.5 text-gray-600">{when(j.created_at)}</td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{nameOf(j)}</span> <span className="text-gray-500">({actionOf(j)}{j.event === "test" ? ", test" : ""})</span>
                    </td>
                    <td className="px-2 py-1.5 text-gray-600">{j.row_ids.filter((x) => x !== null).map((x) => `#${x}`).join(", ")}</td>
                    <td className="px-2 py-1.5">
                      <span className={clsx("rounded-full px-2 py-0.5 font-medium", j.delivery && DELIVERY_BAD.has(j.delivery) ? STATUS_STYLE.failed : STATUS_STYLE[j.status])}>
                        {j.delivery && DELIVERY_BAD.has(j.delivery) ? DELIVERY_LABEL[j.delivery] : j.status === "done" && j.delivery ? "Sent" : STATUS_LABEL[j.status]}
                      </span>
                      {j.attempts > 1 && <span className="ml-1 text-gray-400">×{j.attempts}</span>}
                    </td>
                    <td className="max-w-80 truncate px-2 py-1.5 text-gray-600" title={j.last_error ?? undefined}>
                      {j.last_error ?? (j.delivery && DELIVERY_LABEL[j.delivery] ? DELIVERY_LABEL[j.delivery] : j.last_status ? `HTTP ${j.last_status}` : "")}
                      {j.status === "pending" && j.attempts > 0 && ` · next try ${when(j.next_run_at)}`}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {j.status === "failed" && (
                        <button
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand-700 hover:bg-brand-50"
                          onClick={async () => {
                            const { error } = await supabase().rpc("retry_job", { p_id: j.id });
                            if (error) toast.error(errorMessage(error));
                            void load();
                          }}
                        >
                          <RotateCcw size={12} /> Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function triggerText(a: AutomationRec, table: string) {
  const watch = a.watch_cols.map((id) => useDoc.getState().columns.get(id)?.label || "?").join(", ");
  if (a.trigger === "add") return `When a ${table} record is added`;
  const change = watch ? `${watch} changes` : "a record changes";
  return a.trigger === "update" ? `When ${table}: ${change}` : `When a ${table} record is added or ${change}`;
}

function TestButton({ kind, id, onDone }: { kind: "webhook" | "automation"; id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      title="Send it now with the table's newest record"
      onClick={async () => {
        setBusy(true);
        const { error } = await supabase().rpc("test_integration", { p_kind: kind, p_id: id });
        setBusy(false);
        if (error) toast.error(errorMessage(error));
        else toast.success("Test queued; see Deliveries below");
        onDone();
      }}
    >
      <Play size={12} /> Test
    </Button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

function SecretBox({ secret }: { secret?: string }) {
  if (!secret) return null;
  return (
    <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
      Each request carries <code>X-LMDU-Signature: sha256=…</code>, an HMAC-SHA256 of <code>{"<X-LMDU-Timestamp>.<body>"}</code> with this signing secret:
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-gray-800">{secret}</code>
        <CopyButton text={secret} label="Copy secret" />
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      title={label}
      className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("Copied");
        } catch {
          toast.info(text);
        }
      }}
    >
      <Copy size={13} />
    </button>
  );
}

function EditorShell({
  title,
  children,
  onCancel,
  onSave,
  onDelete,
  busy,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  return (
    <section className="rounded-lg border border-brand-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-4 py-2.5 text-sm font-semibold">{title}</header>
      <div className="space-y-4 p-4">{children}</div>
      <footer className="flex items-center gap-2 border-t border-gray-100 px-4 py-2.5">
        {onDelete && (
          <Button variant="ghost" onClick={onDelete} disabled={busy} className="text-red-600">
            <Trash2 size={13} /> Delete
          </Button>
        )}
        <div className="flex-1" />
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </footer>
    </section>
  );
}

function useTables() {
  const tables = useDoc((s) => s.tables);
  return useMemo(() => [...tables.values()].sort((a, b) => a.position - b.position), [tables]);
}

function WebhookEditor({ rec, docId, onDone }: { rec: WebhookRec; docId: string; onDone: () => void }) {
  const [w, setW] = useState(rec);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();
  const tables = useTables();
  const cols = tableColumns(w.table_ref);
  const set = (p: Partial<WebhookRec>) => setW((x) => ({ ...x, ...p }));
  const toggleEvent = (e: "add" | "update") => set({ events: w.events.includes(e) ? w.events.filter((x) => x !== e) : [...w.events, e] });
  const save = async () => {
    setBusy(true);
    const { error } = await supabase().rpc("save_webhook", { p_doc: docId, p_hook: w });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Webhook saved");
    onDone();
  };
  return (
    <EditorShell
      title={rec.id ? "Edit webhook" : "New webhook"}
      busy={busy}
      onCancel={onDone}
      onSave={save}
      onDelete={
        rec.id
          ? async () => {
              if (!(await confirm({ title: "Delete webhook?", message: "Waiting deliveries are dropped.", confirmLabel: "Delete", danger: true }))) return;
              const { error } = await supabase().rpc("delete_integration", { p_kind: "webhook", p_id: rec.id });
              if (error) return toast.error(errorMessage(error));
              onDone();
            }
          : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={w.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. CRM sync" />
        </Field>
        <Field label="Table">
          <Select value={w.table_ref} onChange={(e) => set({ table_ref: e.target.value, ready_col: null })}>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.table_id}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="URL" hint="https only; local and private network addresses aren't allowed.">
        <Input value={w.url} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="https://hooks.example.com/…" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Send when records are">
          <div className="flex gap-4 pt-1 text-sm">
            {(["add", "update"] as const).map((e) => (
              <label key={e} className="flex items-center gap-2">
                <input type="checkbox" checked={w.events.includes(e)} onChange={() => toggleEvent(e)} /> {e === "add" ? "Added" : "Changed"}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Only when this column is true (optional)" hint="e.g. a Toggle column “Ready”: records are sent once it's ticked.">
          <Select value={w.ready_col ?? ""} onChange={(e) => set({ ready_col: e.target.value || null })}>
            <option value="">Always</option>
            {cols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.col_id}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={w.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Turned on
      </label>
      <p className="text-xs text-gray-500">
        Each request is a POST with JSON <code>{'{"event": "records", "table": …, "records": [{"id": …, "ColId": value, …}]}'}</code>, with the records as they are
        when it is sent.
      </p>
      <SecretBox secret={w.secret} />
    </EditorShell>
  );
}

function AutomationEditor({ rec, docId, mail, onDone }: { rec: AutomationRec; docId: string; mail: EmailStatus | null; onDone: () => void }) {
  const [a, setA] = useState(rec);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();
  const tables = useTables();
  const columns = useDoc((s) => s.columns);
  const cols = tableColumns(a.table_ref);
  const schema: AclSchema = useMemo(() => ({ tables, columns: [...columns.values()], attributes: [] }), [tables, columns]);
  const set = (p: Partial<AutomationRec>) => setA((x) => ({ ...x, ...p }));
  const setAction = (i: number, p: Partial<AutomationAction>) => set({ actions: a.actions.map((x, k) => (k === i ? ({ ...x, ...p } as AutomationAction) : x)) });
  let conditionError: string | null = null;
  try {
    compileCondition(a.condition, schema, a.table_ref);
  } catch (e) {
    conditionError = e instanceof AclConditionError ? e.message : String(e);
  }

  const save = async () => {
    if (conditionError) return toast.error(conditionError);
    for (const act of a.actions) {
      const problem = act.type === "email" ? emailProblem(act, cols) : null;
      if (problem) return toast.error(problem);
    }
    setBusy(true);
    const { error } = await supabase().rpc("save_automation", {
      p_doc: docId,
      p_auto: { ...a, condition_ast: compileCondition(a.condition, schema, a.table_ref) },
    });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Automation saved");
    onDone();
  };

  return (
    <EditorShell
      title={rec.id ? "Edit automation" : "New automation"}
      busy={busy}
      onCancel={onDone}
      onSave={save}
      onDelete={
        rec.id
          ? async () => {
              if (!(await confirm({ title: "Delete automation?", message: "Waiting deliveries are dropped.", confirmLabel: "Delete", danger: true }))) return;
              const { error } = await supabase().rpc("delete_integration", { p_kind: "automation", p_id: rec.id });
              if (error) return toast.error(errorMessage(error));
              onDone();
            }
          : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Tell sales about won deals" />
        </Field>
        <Field label="Table">
          <Select value={a.table_ref} onChange={(e) => set({ table_ref: e.target.value, watch_cols: [], condition: "" })}>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.table_id}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Run when">
          <Select value={a.trigger} onChange={(e) => set({ trigger: e.target.value as AutomationRec["trigger"] })}>
            <option value="add_or_update">A record is added or changes</option>
            <option value="add">A record is added</option>
            <option value="update">A record changes</option>
          </Select>
        </Field>
        {a.trigger !== "add" && (
          <Field label="Only when these columns change (optional)">
            <div className="scroll-thin flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pt-1">
              {cols.map((c) => (
                <label
                  key={c.id}
                  className={clsx(
                    "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                    a.watch_cols.includes(c.id) ? "border-brand-300 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600",
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={a.watch_cols.includes(c.id)}
                    onChange={(e) => set({ watch_cols: e.target.checked ? [...a.watch_cols, c.id] : a.watch_cols.filter((x) => x !== c.id) })}
                  />
                  {c.label || c.col_id}
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
      <Field
        label="Condition (optional)"
        hint={
          conditionError ? (
            <span className="text-red-600">{conditionError}</span>
          ) : (
            <>
              The record after the change, e.g. <code>rec.Status == &quot;Won&quot;</code> or <code>rec.Amount &gt; 1000</code>. Formula columns may lag a moment
              behind.
            </>
          )
        }
      >
        <ConditionInput value={a.condition} disabled={false} schema={schema} tableRef={a.table_ref} onChange={(v) => set({ condition: v })} placeholder="Always" />
      </Field>

      <div className="space-y-3">
        <div className="text-xs font-medium text-gray-600">Then</div>
        {a.actions.map((act, i) => (
          <div key={i} className="rounded-md border border-gray-200 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              {act.type === "email" ? <Mail size={14} className="text-gray-400" /> : <Webhook size={14} className="text-gray-400" />}
              {act.type === "email" ? "Send an email" : "Call a webhook"}
              <div className="flex-1" />
              {a.actions.length > 1 && (
                <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove" onClick={() => set({ actions: a.actions.filter((_, k) => k !== i) })}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            {act.type === "email" ? (
              <EmailActionEditor
                action={act}
                cols={cols}
                status={mail}
                onChange={(p) => setAction(i, p)}
                preview={async () => {
                  const { data, error } = await supabase().rpc("preview_automation", {
                    p_doc: docId,
                    p_auto: { table_ref: a.table_ref, name: a.name, actions: [act] },
                  });
                  if (error) throw error;
                  return data;
                }}
              />
            ) : (
              <div className="space-y-1">
                <Input value={act.url} onChange={(e) => setAction(i, { url: e.target.value.trim() })} placeholder="https://hooks.example.com/…" />
                <p className="text-xs text-gray-500">
                  POSTs <code>{'{"event", "automation", "table", "record": {…}}'}</code>, signed like webhooks with this automation&apos;s secret.
                </p>
              </div>
            )}
          </div>
        ))}
        {a.actions.length < 5 && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => set({ actions: [...a.actions, { type: "email", to: "", subject: "", body: "" }] })}>
              <Plus size={13} /> Email
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set({ actions: [...a.actions, { type: "webhook", url: "" }] })}>
              <Plus size={13} /> Webhook
            </Button>
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={a.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Turned on
      </label>
      <SecretBox secret={a.actions.some((x) => x.type === "webhook") ? a.secret : undefined} />
    </EditorShell>
  );
}

function ApiBox({ docId, tableName }: { docId: string; tableName: string }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const base = `${origin}/api/docs/${docId}`;
  const example = `curl -X PUT "${base}/tables/${tableName}/records" \\
  -H "Authorization: Bearer $LMDU_API_KEY" -H "Content-Type: application/json" \\
  -d '{"records": [{"require": {"Email": "ann@example.com"}, "fields": {"Status": "Won"}}]}'`;
  return (
    <details className="rounded-lg border border-gray-200 bg-white">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold">REST API</summary>
      <div className="space-y-3 border-t border-gray-100 px-4 py-3 text-sm text-gray-700">
        <p>
          Use an API key (account menu → API keys) from n8n, Zapier, Make or scripts. Calls act as the key&apos;s owner, with their role and the access rules.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-gray-50 px-2 py-1 font-mono text-xs">{base}</code>
          <CopyButton text={base} label="Copy base URL" />
        </div>
        <ul className="space-y-0.5 font-mono text-xs text-gray-600">
          <li>GET /tables · GET /tables/{"{table}"}/columns</li>
          <li>GET /tables/{"{table}"}/records?filter={'{"Col":["v"]}'}&amp;sort=-Col&amp;limit=100</li>
          <li>POST …/records (add) · PATCH …/records (update) · PUT …/records (add or update by &quot;require&quot;)</li>
          <li>DELETE …/records?ids=1,2 · POST …/records/delete [1, 2]</li>
        </ul>
        <div className="relative">
          <pre className="scroll-thin overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">{example}</pre>
          <div className="absolute right-1.5 top-1.5">
            <CopyButton text={example} label="Copy example" />
          </div>
        </div>
      </div>
    </details>
  );
}
