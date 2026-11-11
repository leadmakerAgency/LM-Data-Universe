"use client";

import clsx from "clsx";
import { Camera, Eye, GitCompare, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, Modal, Spinner, useDialogs } from "@/components/ui";
import { diffContents, showValue, type DocContent, type DocDiff } from "@/lib/compare";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Profile } from "@/lib/types";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

interface ActionRow {
  id: number;
  author: string | null;
  kind: "do" | "undo" | "redo";
  source: string;
  actions: Op[];
  inverse: Op[];
  created_at: string;
}

interface Op {
  op: string;
  table?: string;
  entity?: string;
  id?: string;
  ids?: number[];
  row?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  records?: { id?: number; values?: Record<string, unknown>; data?: Record<string, unknown> }[];
}

interface SnapshotRow {
  id: number;
  kind: string;
  label: string | null;
  size_bytes: number;
  created_by: string | null;
  created_at: string;
}

const PAGE = 30;

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Human-readable lines for one logged bundle (with before → after values from its inverse). */
function describe(a: ActionRow): string[] {
  const st = useDoc.getState();
  const tableName = (id?: string) => (id ? (st.tables.get(id)?.table_id ?? "a deleted table") : "");
  const colName = (id: string) => {
    const c = st.columns.get(id);
    return c ? c.label || c.col_id : "a deleted column";
  };
  // Old values from the inverse bundle, by table and row.
  const before = new Map<string, Record<string, unknown>>();
  for (const inv of a.inverse ?? []) {
    if (inv.op !== "UpdateRecords") continue;
    for (const r of inv.records ?? []) if (r.id !== undefined) before.set(`${inv.table}:${r.id}`, r.values ?? {});
  }
  const out: string[] = [];
  for (const op of a.actions ?? []) {
    switch (op.op) {
      case "AddRecords":
        out.push(`Added ${op.records?.length ?? 0} record${op.records?.length === 1 ? "" : "s"} to ${tableName(op.table)}`);
        break;
      case "RemoveRecords":
        out.push(`Deleted ${op.ids?.length ?? 0} record${op.ids?.length === 1 ? "" : "s"} from ${tableName(op.table)}`);
        break;
      case "UpdateRecords":
        for (const r of op.records ?? []) {
          const old = before.get(`${op.table}:${r.id}`) ?? {};
          const keys = Object.keys(r.values ?? {});
          if (!keys.length) out.push(`Moved a record in ${tableName(op.table)}`);
          for (const k of keys) out.push(`${tableName(op.table)} #${r.id} · ${colName(k)}: ${showValue(old[k])} → ${showValue(r.values![k])}`);
        }
        break;
      case "Add":
        out.push(`Added ${op.entity} ${String(op.row?.label ?? op.row?.table_id ?? op.row?.name ?? op.row?.title ?? "")}`.trim());
        break;
      case "Update": {
        const keys = Object.keys(op.patch ?? {});
        const name = op.entity === "column" && op.id ? colName(op.id) : op.entity === "table" ? tableName(op.id) : op.entity;
        out.push(`Changed ${op.entity === "column" || op.entity === "table" ? `${op.entity} ${name}` : op.entity}: ${keys.join(", ")}`);
        break;
      }
      case "Remove":
        out.push(`Removed ${op.entity}`);
        break;
      case "Restore":
        out.push("Restored a snapshot");
        break;
      case "Copy":
        out.push("Created as a copy");
        break;
      case "Replace":
        out.push("Replaced with a working copy");
        break;
      default:
        out.push(op.op);
    }
  }
  return out;
}

export function HistoryPanel() {
  const role = useDoc((s) => s.role);
  const snapshot = useDoc((s) => s.snapshot);
  const realRole = snapshot ? snapshot.realRole : role;
  const [tab, setTab] = useState<"activity" | "snapshots">("activity");
  const canSeeSnapshots = realRole === "owner" || realRole === "editor";
  const ruled = useDoc((s) => !!s.acl?.ruled);
  if (ruled && realRole !== "owner") {
    // The log and snapshots hold every value, including ones access rules hide.
    return <p className="p-4 text-sm text-gray-500">This document has access rules, so only owners can see its history and snapshots.</p>;
  }
  return (
    <div className="text-sm">
      <div className="flex border-b border-gray-100 px-4 pt-2 text-xs font-medium">
        {(["activity", "snapshots"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={clsx("-mb-px border-b-2 px-2 py-2 capitalize", tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-gray-500")}>
            {t}
          </button>
        ))}
      </div>
      {tab === "activity" ? <Activity /> : canSeeSnapshots ? <Snapshots canRestore={realRole === "owner"} /> : <p className="p-4 text-gray-500">Only editors and owners can see snapshots.</p>}
    </div>
  );
}

function Activity() {
  const docId = useDoc((s) => s.docId);
  const version = useDoc((s) => s.version);
  const [rows, setRows] = useState<ActionRow[] | null>(null);
  const [people, setPeople] = useState<Map<string, Profile>>(new Map());
  const [more, setMore] = useState(true);

  const fetchPage = useCallback(
    async (beforeId?: number) => {
      if (!docId) return [];
      let q = supabase().from("doc_actions").select("id,author,kind,source,actions,inverse,created_at").eq("doc_id", docId).order("id", { ascending: false }).limit(PAGE);
      if (beforeId) q = q.lt("id", beforeId);
      const { data, error } = await q;
      if (error) {
        toast.error(errorMessage(error));
        return [];
      }
      const list = data as ActionRow[];
      const ids = [...new Set(list.map((r) => r.author).filter(Boolean) as string[])].filter((id) => !people.has(id));
      if (ids.length) {
        const { data: ps } = await supabase().from("profiles").select("id,email,full_name").in("id", ids);
        setPeople((cur) => {
          const next = new Map(cur);
          for (const p of (ps ?? []) as Profile[]) next.set(p.id, p);
          return next;
        });
      }
      setMore(list.length === PAGE);
      return list;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId],
  );

  useEffect(() => {
    // Refresh the newest page whenever the document changes (state is set after the request).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPage().then((list) => setRows((cur) => (cur && cur.length > PAGE ? [...list, ...cur.filter((r) => r.id < (list.at(-1)?.id ?? 0))] : list)));
  }, [fetchPage, version]);

  if (!rows) return <div className="p-4"><Spinner /></div>;
  if (!rows.length) return <p className="p-4 text-gray-500">No changes recorded yet.</p>;
  return (
    <div>
      <ul className="divide-y divide-gray-100">
        {rows.map((a) => {
          const p = a.author ? people.get(a.author) : undefined;
          const name = a.author ? p?.full_name || p?.email || "Someone" : a.source === "form" ? "Form submission" : a.source === "system" ? "System" : "Link visitor";
          const lines = describe(a);
          return (
            <li key={a.id} className="flex gap-2 px-4 py-2.5">
              <Avatar name={name} size={22} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-medium text-gray-800">{name}</span>
                  {a.kind !== "do" && <span className="rounded bg-gray-100 px-1 text-[10px] uppercase text-gray-500">{a.kind}</span>}
                  <span className="ml-auto shrink-0 text-gray-400">{when(a.created_at)}</span>
                </div>
                <ul className="mt-0.5 space-y-0.5 text-xs text-gray-600">
                  {lines.slice(0, 6).map((l, i) => (
                    <li key={i} className="break-words">
                      {l}
                    </li>
                  ))}
                  {lines.length > 6 && <li className="text-gray-400">and {lines.length - 6} more changes</li>}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>
      {more && (
        <div className="p-3 text-center">
          <Button size="sm" onClick={async () => setRows([...(rows ?? []), ...(await fetchPage(rows.at(-1)?.id))])}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}

function Snapshots({ canRestore }: { canRestore: boolean }) {
  const docId = useDoc((s) => s.docId);
  const viewing = useDoc((s) => s.snapshot);
  const router = useRouter();
  const { prompt, confirm } = useDialogs();
  const [list, setList] = useState<SnapshotRow[] | null>(null);
  const [compare, setCompare] = useState<SnapshotRow | null>(null);

  const load = useCallback(async () => {
    if (!docId) return;
    const { data, error } = await supabase()
      .from("doc_snapshots")
      .select("id,kind,label,size_bytes,created_by,created_at")
      .eq("doc_id", docId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return toast.error(errorMessage(error));
    setList(data as SnapshotRow[]);
  }, [docId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const take = async () => {
    const label = await prompt({ title: "Take a snapshot", label: "Label (optional)", confirmLabel: "Take snapshot" });
    if (label === null) return;
    const { error } = await supabase().rpc("take_snapshot", { p_doc: docId, p_label: label });
    if (error) return toast.error(errorMessage(error));
    toast.success("Snapshot saved");
    void load();
  };

  const restore = async (s: SnapshotRow) => {
    const ok = await confirm({
      title: "Restore this snapshot?",
      message: `The document goes back to how it was on ${new Date(s.created_at).toLocaleString()}. A snapshot of the current version is saved first, so you can come back to it. Undo history is cleared.`,
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase().rpc("restore_snapshot", { p_id: s.id });
    if (error) return toast.error(errorMessage(error));
    toast.success("Snapshot restored");
    router.replace(`/doc/${docId}`);
    void useDoc.getState().load(docId!);
    void load();
  };

  const kindLabel = (k: string) => (k === "manual" ? "Saved" : k === "auto" ? "Automatic" : k === "before-restore" ? "Before a restore" : "Before replacing");

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <p className="text-xs text-gray-500">Saved every hour while the document changes; kept daily for 30 days, then weekly.</p>
        {!viewing && (
          <Button size="sm" onClick={take}>
            <Camera size={13} /> Take
          </Button>
        )}
      </div>
      {!list ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : !list.length ? (
        <p className="px-4 pb-4 text-gray-500">No snapshots yet. The first automatic one is taken within the hour after a change.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {list.map((s) => (
            <li key={s.id} className={clsx("px-4 py-2.5", viewing?.id === s.id && "bg-brand-50")}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.label || when(s.created_at)}</div>
                  <div className="text-xs text-gray-500">
                    {s.label ? `${when(s.created_at)} · ` : ""}
                    {kindLabel(s.kind)} · {Math.max(1, Math.round(s.size_bytes / 1024))} KB
                  </div>
                </div>
              </div>
              <div className="mt-1.5 flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => router.push(`/doc/${docId}?snapshot=${s.id}`)}>
                  <Eye size={13} /> Open
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCompare(s)}>
                  <GitCompare size={13} /> Compare
                </Button>
                {canRestore && (
                  <Button size="sm" variant="ghost" onClick={() => restore(s)}>
                    <RotateCcw size={13} /> Restore
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {compare && docId && (
        <CompareDialog
          title={`Snapshot of ${when(compare.created_at)} → current version`}
          load={async () => {
            const [a, b] = await Promise.all([supabase().rpc("get_snapshot", { p_id: compare.id }), supabase().rpc("doc_content", { p_doc: docId })]);
            if (a.error) throw a.error;
            if (b.error) throw b.error;
            return diffContents((a.data as { content: DocContent }).content, b.data as DocContent);
          }}
          onClose={() => setCompare(null)}
        />
      )}
    </div>
  );
}

/** Summary of what changed between two versions, with changed cells. */
export function CompareDialog({ title, load, onClose, footer }: { title: string; load: () => Promise<DocDiff>; onClose: () => void; footer?: React.ReactNode }) {
  const [diff, setDiff] = useState<DocDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setDiff, (e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal open onClose={onClose} title={title} width={720} footer={footer}>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !diff ? (
        <Spinner />
      ) : diff.identical ? (
        <p className="text-sm text-gray-600">No differences.</p>
      ) : (
        <div className="space-y-4 text-sm">
          {(diff.pagesAdded.length > 0 || diff.pagesRemoved.length > 0 || diff.widgetsAdded > 0 || diff.widgetsRemoved > 0) && (
            <div className="text-gray-600">
              {diff.pagesAdded.length > 0 && <div>Pages added: {diff.pagesAdded.join(", ")}</div>}
              {diff.pagesRemoved.length > 0 && <div>Pages removed: {diff.pagesRemoved.join(", ")}</div>}
              {(diff.widgetsAdded > 0 || diff.widgetsRemoved > 0) && (
                <div>
                  Widgets: {diff.widgetsAdded} added, {diff.widgetsRemoved} removed
                </div>
              )}
            </div>
          )}
          {diff.tables
            .filter((t) => t.status !== "same")
            .map((t) => (
              <div key={t.name} className="rounded-md border border-gray-200">
                <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
                  <span className="font-medium">{t.name}</span>
                  <span
                    className={clsx(
                      "rounded px-1.5 text-[11px] font-medium",
                      t.status === "added" ? "bg-green-100 text-green-800" : t.status === "removed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800",
                    )}
                  >
                    {t.status}
                  </span>
                  <span className="ml-auto text-xs text-gray-500">
                    {t.rowsAdded} added · {t.rowsRemoved} removed · {t.rowsChanged} changed records
                  </span>
                </div>
                <div className="space-y-1 px-3 py-2 text-xs text-gray-600">
                  {t.columnsAdded.length > 0 && <div>Columns added: {t.columnsAdded.join(", ")}</div>}
                  {t.columnsRemoved.length > 0 && <div>Columns removed: {t.columnsRemoved.join(", ")}</div>}
                  {t.columnsChanged.map((c) => (
                    <div key={c.name}>
                      {c.name}: {c.what.join("; ")}
                    </div>
                  ))}
                  {t.cells.length > 0 && (
                    <table className="mt-1 w-full">
                      <tbody>
                        {t.cells.slice(0, 50).map((c, i) => (
                          <tr key={i} className="border-t border-gray-50">
                            <td className="w-16 py-0.5 text-gray-400">#{c.rowId}</td>
                            <td className="w-32 truncate py-0.5">{c.column}</td>
                            <td className="py-0.5">
                              <span className="text-red-700 line-through decoration-red-300">{showValue(c.before)}</span> →{" "}
                              <span className="text-green-800">{showValue(c.after)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {t.cells.length > 50 && <div className="text-gray-400">and {t.cells.length - 50} more changed cells</div>}
                </div>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}
