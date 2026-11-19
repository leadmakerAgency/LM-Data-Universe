"use client";

import clsx from "clsx";
import { ArrowLeft, Download, RefreshCw, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/Logo";
import { Button, Input, Select, Spinner, useDialogs } from "@/components/ui";
import { formatBytes, type Plan } from "@/components/UsageDialog";
import { AUDIT_EVENT_GROUPS, describeEvent, downloadAuditCsv, fetchAuditPage, type AuditEvent, type AuditQuery } from "@/lib/audit";
import { useRequireSession } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import { toast } from "@/store/toasts";
import { MailTab } from "./MailTab";

interface Overview {
  people: number;
  teams: number;
  documents: number;
  trashed: number;
  rows: number;
  attachment_bytes: number;
  admins: number;
  activity: Record<string, number>;
  daily: { day: string; actions: number }[];
}

interface Account {
  kind: "user" | "team";
  id: string;
  name: string;
  email: string | null;
  plan: string;
  members: number;
  docs: number;
  rows: number;
  largest_doc_rows: number;
  attachment_bytes: number;
  actions_30d: number;
  api_calls_30d: number;
  is_admin: boolean;
  created_at: string;
}

type Tab = "overview" | "accounts" | "mail" | "audit";

const SOURCES: Record<string, string> = {
  "actions.app": "Edits in the app",
  "actions.api": "Changes through the API",
  "actions.form": "Form responses",
  "actions.automation": "Automations",
  "actions.system": "Formula worker",
  "actions.assistant": "Assistant",
  api_calls: "API calls",
};

const num = (n: number | string) => Number(n).toLocaleString();
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** /admin: accounts, plans, usage and the audit log. Administrators only (app_admins). */
export function AdminScreen() {
  const session = useRequireSession();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [auditFilter, setAuditFilter] = useState<AuditQuery>({});

  useEffect(() => {
    if (!session) return;
    void supabase()
      .rpc("is_app_admin")
      .then(({ data, error }) => setAllowed(!error && data === true));
  }, [session]);

  if (!session || allowed === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-gray-600">The admin panel is for administrators of this LM Data Universe installation.</p>
        <Link href="/">
          <Button>
            <ArrowLeft size={14} /> Back to documents
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
        <Link href="/" title="All documents" className="rounded-md p-1 hover:bg-gray-100">
          <Logo compact />
        </Link>
        <h1 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck size={16} className="text-brand-600" /> Admin panel
        </h1>
        <nav className="ml-4 flex gap-1" role="tablist" aria-label="Admin sections">
          {(["overview", "accounts", "mail", "audit"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={clsx("rounded-md px-3 py-1.5 text-sm", tab === t ? "bg-brand-50 font-medium text-brand-700" : "text-gray-600 hover:bg-gray-100")}
            >
              {t === "overview" ? "Overview" : t === "accounts" ? "Accounts and plans" : t === "mail" ? "Email" : "Audit log"}
            </button>
          ))}
        </nav>
      </header>
      <main className="scroll-thin min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-6xl">
          {tab === "overview" && <OverviewTab />}
          {tab === "accounts" && (
            <AccountsTab
              me={session.user.id}
              onAudit={(q) => {
                setAuditFilter(q);
                setTab("audit");
              }}
            />
          )}
          {tab === "mail" && <MailTab />}
          {tab === "audit" && <AuditTab key={JSON.stringify(auditFilter)} initial={auditFilter} />}
        </div>
      </main>
    </div>
  );
}

/** All 30 days up to today (UTC, like the database's dates), days without changes as 0. */
function last30Days(daily: { day: string; actions: number }[]): { day: string; actions: number }[] {
  const byDay = new Map(daily.map((d) => [d.day, Number(d.actions)]));
  const latest = daily.reduce((m, d) => (d.day > m ? d.day : m), new Date().toISOString().slice(0, 10));
  const end = Date.parse(`${latest}T00:00:00Z`);
  return Array.from({ length: 30 }, (_, i) => {
    const day = new Date(end - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, actions: byDay.get(day) ?? 0 };
  });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function OverviewTab() {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    void supabase()
      .rpc("admin_overview")
      .then(({ data, error }) => (error ? toast.error(errorMessage(error)) : setO(data as Overview)));
  }, []);
  if (!o) return <Spinner />;
  const days = last30Days(o.daily);
  const peak = Math.max(1, ...days.map((d) => d.actions));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="People" value={num(o.people)} sub={`${o.admins} administrator${o.admins === 1 ? "" : "s"}`} />
        <Stat label="Teams" value={num(o.teams)} />
        <Stat label="Documents" value={num(o.documents)} sub={`${num(o.trashed)} in the trash`} />
        <Stat label="Records" value={num(o.rows)} />
        <Stat label="Attachments" value={formatBytes(Number(o.attachment_bytes))} />
        <Stat label="Changes (30 days)" value={num(Object.entries(o.activity).filter(([k]) => k.startsWith("actions.")).reduce((s, [, v]) => s + Number(v), 0))} />
      </div>
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Changes per day, last 30 days</h2>
        {o.daily.length ? (
          <>
            <div className="flex">
              <div className="flex h-32 w-10 shrink-0 flex-col justify-between pr-2 text-right text-[11px] tabular-nums text-gray-400">
                <span>{num(peak)}</span>
                <span>0</span>
              </div>
              <div className="flex h-32 flex-1 items-end gap-1 border-b border-l border-gray-200" role="img" aria-label="Changes per day">
                {days.map((d) => (
                  <div key={d.day} className="group relative flex h-full flex-1 items-end">
                    <div
                      className="w-full rounded-t bg-brand-500/80 group-hover:bg-brand-600"
                      style={{ height: d.actions ? `${Math.max(2, (d.actions / peak) * 128)}px` : 0 }}
                    />
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-white group-hover:block">
                      {d.day}: {num(d.actions)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="ml-10 mt-1 flex justify-between text-[11px] tabular-nums text-gray-400">
              <span>{days[0].day}</span>
              <span>{days[days.length - 1].day}</span>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-500">No activity recorded yet.</p>
        )}
      </section>
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Activity by source, last 30 days</h2>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          {Object.entries(o.activity)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-gray-100 py-1">
                <dt className="text-gray-600">{SOURCES[k] ?? k}</dt>
                <dd className="tabular-nums">{num(v)}</dd>
              </div>
            ))}
          {!Object.keys(o.activity).length && <p className="text-gray-500">Nothing yet.</p>}
        </dl>
      </section>
    </div>
  );
}

function AccountsTab({ me, onAudit }: { me: string; onAudit(q: AuditQuery): void }) {
  const { confirm } = useDialogs();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [rows, setRows] = useState<Account[] | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "user" | "team">("all");

  const load = useCallback(async () => {
    const sb = supabase();
    const [p, a] = await Promise.all([sb.from("plans").select("*").order("position"), sb.rpc("admin_accounts", { p_search: query || null })]);
    if (p.error || a.error) return toast.error(errorMessage(p.error ?? a.error));
    setPlans(p.data as Plan[]);
    setRows(a.data as Account[]);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const planOf = useMemo(() => new Map(plans.map((p) => [p.id, p])), [plans]);
  const shown = (rows ?? []).filter((r) => kind === "all" || r.kind === kind);

  const setPlan = async (a: Account, plan: string) => {
    const ok = await confirm({
      title: "Change plan?",
      message: `${a.kind === "team" ? `Team "${a.name}"` : a.email} moves from ${planOf.get(a.plan)?.name ?? a.plan} to ${planOf.get(plan)?.name ?? plan}. Lower limits don't remove anything, but block adding past them.`,
      confirmLabel: "Change plan",
    });
    if (!ok) return;
    const { error } = await supabase().rpc("admin_set_plan", { p_kind: a.kind, p_id: a.id, p_plan: plan });
    if (error) return toast.error(errorMessage(error));
    toast.success("Plan changed");
    void load();
  };

  const setAdmin = async (a: Account, admin: boolean) => {
    const ok = await confirm({
      title: admin ? "Make administrator?" : "Remove administrator?",
      message: admin
        ? `${a.email} will see every account, change plans and read the whole audit log.`
        : `${a.email} will no longer have access to the admin panel.`,
      confirmLabel: admin ? "Make administrator" : "Remove",
      danger: !admin,
    });
    if (!ok) return;
    const { error } = await supabase().rpc("admin_set_admin", { p_user: a.id, p_admin: admin });
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const limitCls = (used: number, max: number | null | undefined) =>
    max && used >= max ? "font-semibold text-red-600" : max && used >= max * 0.8 ? "text-amber-600" : "";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email, name or team" aria-label="Search accounts" className="pl-8" />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Account kind" className="w-40">
          <option value="all">People and teams</option>
          <option value="user">People</option>
          <option value="team">Teams</option>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => void load()} title="Refresh">
          <RefreshCw size={14} />
        </Button>
        <span className="ml-auto text-xs text-gray-500">
          A person&apos;s plan covers their own workspaces; a team&apos;s plan covers the team&apos;s workspaces.
        </span>
      </div>
      {!rows ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 text-right font-medium">Documents</th>
                <th className="px-3 py-2 text-right font-medium" title="All records · records in the largest document">
                  Records
                </th>
                <th className="px-3 py-2 text-right font-medium">Storage</th>
                <th className="px-3 py-2 text-right font-medium">Changes 30d</th>
                <th className="px-3 py-2 text-right font-medium">API 30d</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((a) => {
                const p = planOf.get(a.plan);
                return (
                  <tr key={`${a.kind}:${a.id}`} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", a.kind === "team" ? "bg-violet-50 text-violet-700" : "bg-gray-100 text-gray-600")}>
                          {a.kind === "team" ? "Team" : "Person"}
                        </span>
                        <span className="font-medium text-gray-900">{a.kind === "team" ? a.name : a.email}</span>
                        {a.is_admin && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">ADMIN</span>}
                      </div>
                      <div className="text-xs text-gray-500">
                        {a.kind === "team" ? `${a.members} member${a.members === 1 ? "" : "s"}` : a.name || " "} · since {new Date(a.created_at).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Select value={a.plan} onChange={(e) => void setPlan(a, e.target.value)} aria-label={`Plan of ${a.kind === "team" ? a.name : a.email}`} className="h-8 w-32">
                        {plans.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={clsx("px-3 py-2 text-right tabular-nums", limitCls(a.docs, p?.max_docs))}>
                      {num(a.docs)}
                      {p?.max_docs ? <span className="text-gray-400"> / {num(p.max_docs)}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(a.rows)}
                      <div className={clsx("text-xs text-gray-500", limitCls(a.largest_doc_rows, p?.max_rows_per_doc))}>
                        largest {num(a.largest_doc_rows)}
                        {p?.max_rows_per_doc ? ` / ${num(p.max_rows_per_doc)}` : ""}
                      </div>
                    </td>
                    <td className={clsx("px-3 py-2 text-right tabular-nums", limitCls(Number(a.attachment_bytes), p?.max_attachment_mb ? p.max_attachment_mb * 1048576 : null))}>
                      {formatBytes(Number(a.attachment_bytes))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(a.actions_30d)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.kind === "user" ? num(a.api_calls_30d) : "–"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => onAudit(a.kind === "team" ? { team: a.id } : { actor: a.email })}>
                        Audit log
                      </Button>
                      {a.kind === "user" && a.id !== me && (
                        <Button size="sm" variant="ghost" onClick={() => void setAdmin(a, !a.is_admin)}>
                          {a.is_admin ? "Remove admin" : "Make admin"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!shown.length && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-500">
                    No accounts match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length >= 2000 && <p className="text-xs text-gray-500">Showing the first 2,000 accounts; search to narrow down.</p>}
    </div>
  );
}

const PAGE = 100;

function AuditTab({ initial }: { initial: AuditQuery }) {
  const [group, setGroup] = useState(initial.event ?? "");
  const [actor, setActor] = useState(initial.actor ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const q: AuditQuery = useMemo(
    () => ({
      team: initial.team ?? null,
      event: group || null,
      actor: actor.trim() || null,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : null,
      to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString() : null,
    }),
    [initial.team, group, actor, from, to],
  );

  const load = useCallback(
    async (before: number | null) => {
      setBusy(true);
      try {
        const page = await fetchAuditPage(q, PAGE, before);
        setEvents((prev) => (before ? [...(prev ?? []), ...page] : page));
        setMore(page.length === PAGE);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [q],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(null), 250);
    return () => clearTimeout(t);
  }, [load]);

  const download = async () => {
    setBusy(true);
    try {
      const n = await downloadAuditCsv(q, `audit log ${new Date().toISOString().slice(0, 10)}.csv`);
      toast.info(`${num(n)} event${n === 1 ? "" : "s"} downloaded`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">
          What
          <Select value={group} onChange={(e) => setGroup(e.target.value)} className="mt-0.5 w-52">
            <option value="">All events</option>
            {AUDIT_EVENT_GROUPS.map((g) => (
              <option key={g.prefix} value={g.prefix}>
                {g.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-gray-500">
          Who
          <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Email contains…" className="mt-0.5 w-52" />
        </label>
        <label className="text-xs text-gray-500">
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-0.5 w-40" />
        </label>
        <label className="text-xs text-gray-500">
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-0.5 w-40" />
        </label>
        {initial.team && <span className="mb-2 rounded bg-violet-50 px-2 py-1 text-xs text-violet-700">One team only</span>}
        <div className="flex-1" />
        <Button size="sm" onClick={download} disabled={busy}>
          <Download size={14} /> Download CSV
        </Button>
      </div>
      {!events ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium">Where</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-gray-600">{when(e.at)}</td>
                  <td className="px-3 py-2">{e.actor_email ?? <span className="text-gray-400">{e.actor ? "deleted account" : "system"}</span>}</td>
                  <td className="px-3 py-2">
                    {describeEvent(e)}
                    <div className="font-mono text-[11px] text-gray-400">{e.event}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {e.doc_id && e.doc_name && e.event !== "doc.deleted" ? (
                      <Link className="text-brand-600 hover:underline" href={`/doc/${e.doc_id}`}>
                        {e.doc_name}
                      </Link>
                    ) : null}
                    {e.team_name && <div className="text-xs text-gray-500">Team {e.team_name}</div>}
                  </td>
                </tr>
              ))}
              {!events.length && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-gray-500">
                    No events match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {more && (
        <div className="flex justify-center">
          <Button size="sm" disabled={busy} onClick={() => events && void load(events[events.length - 1].id)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
