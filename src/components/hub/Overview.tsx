"use client";

// Overview: the workspace at a glance, each tile opening the section it counts.
import Link from "next/link";
import { useMemo } from "react";
import { formatNumber } from "@/lib/format";
import { clientColumn, type HubConfig } from "@/lib/hub";
import type { DocColumn } from "@/lib/types";
import { isDate, toNumber } from "@engine/values";
import { getDerived, tableColumns, useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";
import { tileTitleText } from "../doc/RecordTile";

const DAY = 86_400_000;
const byLabel = (cols: DocColumn[], label: string, type?: DocColumn["type"]) => cols.find((c) => c.label === label || c.col_id === label) ?? (type ? cols.find((c) => c.type === type) : undefined);

function Tile({ label, value, sub, href }: { label: string; value: string; sub?: string; href: string }) {
  return (
    <Link href={href} className="rounded-lg border border-gray-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </Link>
  );
}

export function Overview({ wsId, config, client, workspaceName }: { wsId: string; config: HubConfig; client: number | null; workspaceName: string }) {
  const version = useDoc((s) => s.version);
  const q = client ? `?client=${client}` : "";
  const section = (key: string) => config.sections.find((s) => s.key === key);
  const pipeline = section("pipeline");
  const planning = section("planning");
  const files = section("files");

   
  const stats = useMemo(() => {
    const { engine } = getDerived();
    const today = new Date();
    const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const forClient = (table: string) => {
      const ids = engine.rowIds(table);
      const col = clientColumn(tableColumns(table), config.clients);
      if (!client || !col) return ids;
      return ids.filter((id) => {
        const v = engine.safeValue(col, id) as { rowId?: number; ids?: number[] } | null;
        return v?.rowId === client || !!v?.ids?.includes(client);
      });
    };
    const out = { open: 0, openCount: 0, wonMonth: 0, wonCount: 0, byStage: [] as { stage: string; count: number; value: number }[], valueCol: undefined as DocColumn | undefined, due: [] as number[], overdue: 0, filesTotal: 0, filesWeek: 0 };
    if (pipeline) {
      const cols = tableColumns(pipeline.table);
      const stage = byLabel(cols, "Stage", "Choice");
      const value = byLabel(cols, "Value", "Numeric");
      const close = byLabel(cols, "Close date", "Date");
      out.valueCol = value;
      const stages = new Map<string, { count: number; value: number }>((stage?.options.choices ?? []).map((c) => [c, { count: 0, value: 0 }]));
      for (const id of forClient(pipeline.table)) {
        const s = stage ? String(engine.safeValue(stage, id) ?? "") : "";
        const v = value ? (toNumber(engine.safeValue(value, id)) ?? 0) : 0;
        const e = stages.get(s) ?? { count: 0, value: 0 };
        e.count++;
        e.value += v;
        if (s) stages.set(s, e);
        if (s !== "Won" && s !== "Lost") {
          out.open += v;
          out.openCount++;
        }
        const d = close ? engine.safeValue(close, id) : null;
        if (s === "Won" && isDate(d) && d.getUTCFullYear() === today.getFullYear() && d.getUTCMonth() === today.getMonth()) {
          out.wonMonth += v;
          out.wonCount++;
        }
      }
      out.byStage = [...stages].map(([s, e]) => ({ stage: s, ...e }));
    }
    if (planning) {
      const cols = tableColumns(planning.table);
      const status = byLabel(cols, "Status", "Choice");
      const due = byLabel(cols, "Due") ?? cols.filter((c) => c.type === "Date").pop();
      for (const id of forClient(planning.table)) {
        const done = status ? String(engine.safeValue(status, id) ?? "") === "Done" : false;
        const d = due ? engine.safeValue(due, id) : null;
        if (done || !isDate(d)) continue;
        if (d.getTime() < t0) out.overdue++;
        else if (d.getTime() < t0 + 7 * DAY) out.due.push(id);
      }
    }
    if (files) {
      const cols = tableColumns(files.table);
      const received = byLabel(cols, "Received", "Date");
      const list = forClient(files.table);
      out.filesTotal = list.length;
      out.filesWeek = received ? list.filter((id) => {
        const d = engine.safeValue(received, id);
        return isDate(d) && d.getTime() >= t0 - 7 * DAY;
      }).length : 0;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, client, config]);

  const money = (n: number) => (stats.valueCol ? formatNumber(n, stats.valueCol) : n.toLocaleString());
  const peak = Math.max(1, ...stats.byStage.map((s) => s.count));
  const base = `/w/${wsId}`;
  const clientName = client ? tileTitleText(config.clients, client, {}) : null;

  return (
    <div className="scroll-thin h-full overflow-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{clientName ?? workspaceName}</h1>
          <p className="mt-1 text-sm text-gray-600">{clientName ? "This client at a glance." : "Your clients, deals, work and files at a glance."}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {pipeline && <Tile label="Open pipeline" value={money(stats.open)} sub={`${stats.openCount} open deal${stats.openCount === 1 ? "" : "s"}`} href={`${base}/${pipeline.key}${q}`} />}
          {pipeline && <Tile label="Won this month" value={money(stats.wonMonth)} sub={`${stats.wonCount} deal${stats.wonCount === 1 ? "" : "s"}`} href={`${base}/${pipeline.key}${q}`} />}
          {planning && <Tile label="Due this week" value={String(stats.due.length)} sub="tasks not done" href={`${base}/${planning.key}${q}`} />}
          {planning && <Tile label="Overdue" value={String(stats.overdue)} sub="tasks past their due date" href={`${base}/${planning.key}${q}`} />}
          {files && <Tile label="Files" value={String(stats.filesTotal)} sub={`${stats.filesWeek} received this week`} href={`${base}/${files.key}${q}`} />}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {pipeline && (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold">Deals by stage</h2>
              {stats.byStage.length === 0 ? (
                <p className="text-sm text-gray-500">No deals yet.</p>
              ) : (
                <ul className="space-y-2">
                  {stats.byStage.map((s) => (
                    <li key={s.stage} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
                      <span className="truncate text-gray-700">{s.stage}</span>
                      <span className="h-2.5 rounded-full bg-gray-100">
                        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${(s.count / peak) * 100}%` }} />
                      </span>
                      <span className="whitespace-nowrap text-xs tabular-nums text-gray-600">
                        {s.count} · {money(s.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {planning && (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold">Due in the next 7 days</h2>
              {stats.due.length === 0 ? (
                <p className="text-sm text-gray-500">Nothing due this week.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {stats.due.slice(0, 12).map((id) => (
                    <li key={id}>
                      <button className="w-full truncate py-1.5 text-left text-sm hover:text-brand-700" onClick={() => useUi.getState().openRecordCard({ tableRef: planning.table, rowId: id })}>
                        {tileTitleText(planning.table, id, {})}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
