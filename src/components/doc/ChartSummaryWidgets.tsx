"use client";

import clsx from "clsx";
import { useEffect, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CellContent, isRightAligned } from "./CellContent";
import { useWidgetRows } from "./CardWidgets";
import { displayValue, formatNumber } from "@/lib/format";
import { FormulaError, toNumber } from "@/lib/formula/values";
import type { DocColumn, DocWidget } from "@/lib/types";
import { summaryGroups } from "@/lib/view";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";

export const CHART_COLORS = ["#6a55e8", "#14b8a6", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16", "#f97316", "#8b5cf6", "#64748b", "#ef4444"];

function numericColumns(cols: DocColumn[]) {
  return cols.filter((c) => c.type === "Numeric" || c.type === "Int");
}

export function ChartWidget({ widget }: { widget: DocWidget }) {
  const { ids, link } = useWidgetRows(widget);
  const version = useDoc((s) => s.version);
  const o = widget.options;
  const chartType = o.chartType ?? "bar";
  const aggregate = o.aggregate ?? "sum";
  const yKey = (o.yCols ?? []).join(",");

  const { data, series, xLabel } = useMemo(() => {
    const cols = tableColumns(widget.table_ref);
    const xCol = cols.find((c) => c.id === o.xCol) ?? null;
    const yCols = (o.yCols ?? []).map((id) => cols.find((c) => c.id === id)).filter((c): c is DocColumn => !!c);
    const { engine } = getDerived();
    const ctx = displayCtx();
    const label = (id: number) => (xCol ? displayValue(ctx, xCol, engine.safeValue(xCol, id)) || "(blank)" : `#${id}`);
    const num = (c: DocColumn, id: number) => {
      const v = engine.safeValue(c, id);
      return v instanceof FormulaError ? 0 : (toNumber(v) ?? 0);
    };
    const names = aggregate === "count" || !yCols.length ? ["Count"] : yCols.map((c) => c.label || c.col_id);
    let rows: Record<string, string | number>[];
    if (aggregate === "none") {
      rows = ids.map((id) => {
        const r: Record<string, string | number> = { x: label(id) };
        yCols.forEach((c, i) => (r[names[i]] = num(c, id)));
        return r;
      });
    } else {
      const groups = new Map<string, number[]>();
      for (const id of ids) {
        const k = label(id);
        const g = groups.get(k);
        if (g) g.push(id);
        else groups.set(k, [id]);
      }
      rows = [...groups.entries()].map(([x, members]) => {
        const r: Record<string, string | number> = { x };
        if (aggregate === "count" || !yCols.length) r.Count = members.length;
        else
          yCols.forEach((c, i) => {
            const total = members.reduce((s, id) => s + num(c, id), 0);
            r[names[i]] = aggregate === "avg" ? total / members.length : total;
          });
        return r;
      });
      if (xCol && (xCol.type === "Numeric" || xCol.type === "Int" || xCol.type === "Date")) {
        rows.sort((a, b) => String(a.x).localeCompare(String(b.x), undefined, { numeric: true }));
      }
    }
    return { data: rows, series: names, xLabel: xCol?.label ?? "" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version, o.xCol, yKey, aggregate, widget.table_ref]);

  if (link.waiting) return <Empty text="Select a record in the linked widget." />;
  if (!data.length) return <Empty text="No data to chart yet." />;

  const fmt = (v: unknown) => (typeof v === "number" ? formatNumber(v, { type: "Numeric", options: { decimals: Number.isInteger(v) ? 0 : 2, numMode: "decimal" } }) : String(v));
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" />
      <XAxis dataKey="x" tick={{ fontSize: 11 }} name={xLabel} />
      <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={56} />
      <Tooltip formatter={(v) => fmt(v)} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );

  return (
    <div className="h-full w-full p-3">
      <ResponsiveContainer width="100%" height="100%">
        {chartType === "pie" ? (
          <PieChart>
            <Pie data={data} dataKey={series[0]} nameKey="x" outerRadius="75%" innerRadius="40%" paddingAngle={1} label={{ fontSize: 11 }}>
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => fmt(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        ) : chartType === "line" ? (
          <LineChart data={data}>
            {axes}
            {series.map((s, i) => (
              <Line key={s} type="monotone" dataKey={s} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        ) : chartType === "area" ? (
          <AreaChart data={data}>
            {axes}
            {series.map((s, i) => (
              <Area
                key={s}
                type="monotone"
                dataKey={s}
                stackId={o.stacked ? "a" : undefined}
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                fill={CHART_COLORS[i % CHART_COLORS.length]}
                fillOpacity={0.25}
              />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={data}>
            {axes}
            {series.map((s, i) => (
              <Bar key={s} dataKey={s} stackId={o.stacked ? "a" : undefined} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Groups the table by the chosen columns and shows a count and totals. */
export function SummaryWidget({ widget }: { widget: DocWidget }) {
  const version = useDoc((s) => s.version);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  const { groups, groupCols, sumCols } = useMemo(() => {
    const cols = tableColumns(widget.table_ref);
    const groupBy = widget.options.groupBy ?? [];
    const groupCols = groupBy.map((id) => cols.find((c) => c.id === id)).filter((c): c is DocColumn => !!c);
    const sumCols = numericColumns(cols).filter((c) => !groupBy.includes(c.id));
    return { groups: summaryGroups(widget), groupCols, sumCols };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, widget]);

  useEffect(() => {
    if (selected === null || selected >= groups.length) useDoc.getState().setCursor(widget.id, groups.length ? 0 : null);
  }, [groups.length, selected, widget.id]);

  const { engine } = getDerived();
  const total = (c: DocColumn, ids: number[]) =>
    ids.reduce((s, id) => {
      const v = engine.safeValue(c, id);
      return s + (v instanceof FormulaError ? 0 : (toNumber(v) ?? 0));
    }, 0);

  return (
    <div className="scroll-thin h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-gray-50 text-xs text-gray-600">
          <tr>
            {groupCols.map((c) => (
              <th key={c.id} className="border-b border-r border-gray-200 px-3 py-2 text-left font-medium">
                {c.label || c.col_id}
              </th>
            ))}
            <th className="border-b border-r border-gray-200 px-3 py-2 text-right font-medium">Count</th>
            {sumCols.map((c) => (
              <th key={c.id} className="border-b border-r border-gray-200 px-3 py-2 text-right font-medium">
                Σ {c.label || c.col_id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr
              key={g.key}
              onClick={() => useDoc.getState().setCursor(widget.id, i)}
              className={clsx("cursor-pointer", selected === i ? "bg-brand-50" : "hover:bg-gray-50")}
            >
              {groupCols.map((c, k) => (
                <td key={c.id} className="max-w-60 border-b border-r border-gray-100 px-3 py-1.5">
                  <span className="flex">
                    <CellContent col={c} value={g.values[k]} />
                  </span>
                </td>
              ))}
              <td className="border-b border-r border-gray-100 px-3 py-1.5 text-right tabular-nums">{g.rowIds.length}</td>
              {sumCols.map((c) => (
                <td key={c.id} className={clsx("border-b border-r border-gray-100 px-3 py-1.5 tabular-nums", isRightAligned(c) && "text-right")}>
                  {formatNumber(total(c, g.rowIds), c)}
                </td>
              ))}
            </tr>
          ))}
          {!groups.length && (
            <tr>
              <td colSpan={groupCols.length + 1 + sumCols.length} className="px-3 py-6 text-center text-gray-400">
                No records.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-gray-400">{text}</div>;
}
