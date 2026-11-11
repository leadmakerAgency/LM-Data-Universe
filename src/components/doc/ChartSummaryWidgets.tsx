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
  ErrorBar,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CellContent, isRightAligned } from "./CellContent";
import { useWidgetRows } from "./CardWidgets";
import { displayValue, formatNumber } from "@/lib/format";
import { FormulaError, RecordSet, isDate, toNumber } from "@engine/values";
import type { DocColumn, DocWidget } from "@/lib/types";
import { bucketLabel, summaryGroups, type SummaryGroup } from "@/lib/view";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";

export const CHART_COLORS = ["#6a55e8", "#14b8a6", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16", "#f97316", "#8b5cf6", "#64748b", "#ef4444"];
const MAX_SPLIT = 12;

function numericColumns(cols: DocColumn[]) {
  return cols.filter((c) => c.type === "Numeric" || c.type === "Int");
}

type Row = Record<string, string | number | null>;
interface ScatterSeries {
  name: string;
  points: { x: number; y: number; err?: number; _id: number }[];
}

/** Totals numbers the way the chart's "Values" setting says; error sizes add in quadrature. */
export function combine(values: number[], how: "sum" | "avg", error = false): number {
  if (!values.length) return 0;
  if (error) {
    const sq = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
    return how === "avg" ? sq / values.length : sq;
  }
  const total = values.reduce((s, v) => s + v, 0);
  return how === "avg" ? total / values.length : total;
}

export function ChartWidget({ widget }: { widget: DocWidget }) {
  const { ids, link } = useWidgetRows(widget);
  const version = useDoc((s) => s.version);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  const o = widget.options;
  const chartType = o.chartType ?? "bar";
  const aggregate = chartType === "scatter" ? "none" : (o.aggregate ?? "sum");
  const yKey = (o.yCols ?? []).join(",");
  const errKey = JSON.stringify(o.errorCols ?? {});

  const { data, series, xLabel, scatter, xIsDate } = useMemo(() => {
    const cols = tableColumns(widget.table_ref);
    const xCol = cols.find((c) => c.id === o.xCol) ?? null;
    const yCols = (o.yCols ?? []).map((id) => cols.find((c) => c.id === id)).filter((c): c is DocColumn => !!c);
    const split = chartType === "pie" ? null : (cols.find((c) => c.id === o.splitBy) ?? null);
    const errCol = (c: DocColumn | null | undefined) => (c ? (cols.find((x) => x.id === o.errorCols?.[c.id]) ?? null) : null);
    const { engine } = getDerived();
    const ctx = displayCtx();
    const text = (c: DocColumn, id: number) => displayValue(ctx, c, engine.safeValue(c, id)) || "(blank)";
    const label = (id: number) => (xCol ? text(xCol, id) : `#${id}`);
    const num = (c: DocColumn, id: number) => {
      const v = engine.safeValue(c, id);
      return v instanceof FormulaError ? 0 : (toNumber(v) ?? 0);
    };
    const counting = aggregate === "count" || !yCols.length;
    const how = aggregate === "avg" ? "avg" : "sum";

    // Split series: one per value of the split column (the most common ones).
    let splitNames: string[] = [];
    if (split) {
      const counts = new Map<string, number>();
      for (const id of ids) counts.set(text(split, id), (counts.get(text(split, id)) ?? 0) + 1);
      splitNames = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SPLIT)
        .map(([k]) => k)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    if (chartType === "scatter") {
      const xNum = (id: number, i: number): number | null => {
        if (!xCol) return i + 1;
        const v = engine.safeValue(xCol, id);
        if (isDate(v)) return v.getTime();
        return v instanceof FormulaError ? null : toNumber(v);
      };
      const out: ScatterSeries[] = [];
      const measures = split ? yCols.slice(0, 1) : yCols;
      for (const c of measures) {
        const e = errCol(c);
        for (const name of split ? splitNames : [c.label || c.col_id]) {
          const points: ScatterSeries["points"] = [];
          ids.forEach((id, i) => {
            if (split && text(split, id) !== name) return;
            const x = xNum(id, i);
            const yv = engine.safeValue(c, id);
            const y = yv instanceof FormulaError ? null : toNumber(yv);
            if (x === null || y === null) return;
            points.push({ x, y, _id: id, ...(e ? { err: Math.abs(num(e, id)) } : {}) });
          });
          out.push({ name, points });
        }
      }
      const xIsDate = !!xCol && (xCol.type === "Date" || xCol.type === "DateTime");
      return { data: [] as Row[], series: out.map((s) => s.name), xLabel: xCol?.label || xCol?.col_id || "", scatter: out, xIsDate };
    }

    const names = split ? splitNames : counting ? ["Count"] : yCols.map((c) => c.label || c.col_id);
    let rows: Row[];
    if (aggregate === "none") {
      rows = ids.map((id) => {
        const r: Row = { x: label(id), _id: id };
        if (split) {
          const c = yCols[0];
          const e = errCol(c);
          const name = text(split, id);
          if (names.includes(name)) {
            r[name] = c ? num(c, id) : 1;
            if (e) r[`${name}__err`] = Math.abs(num(e, id));
          }
        } else {
          yCols.forEach((c, i) => {
            r[names[i]] = num(c, id);
            const e = errCol(c);
            if (e) r[`${names[i]}__err`] = Math.abs(num(e, id));
          });
        }
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
        const r: Row = { x };
        if (split) {
          const c = counting ? null : yCols[0];
          const e = errCol(c);
          for (const name of names) {
            const part = members.filter((id) => text(split, id) === name);
            r[name] = part.length ? (c ? combine(part.map((id) => num(c, id)), how) : part.length) : null;
            if (e && part.length) r[`${name}__err`] = combine(part.map((id) => Math.abs(num(e, id))), how, true);
          }
        } else if (counting) {
          r.Count = members.length;
        } else {
          yCols.forEach((c, i) => {
            r[names[i]] = combine(members.map((id) => num(c, id)), how);
            const e = errCol(c);
            if (e) r[`${names[i]}__err`] = combine(members.map((id) => Math.abs(num(e, id))), how, true);
          });
        }
        return r;
      });
      if (xCol && (xCol.type === "Numeric" || xCol.type === "Int" || xCol.type === "Date")) {
        rows.sort((a, b) => String(a.x).localeCompare(String(b.x), undefined, { numeric: true }));
      }
    }
    return { data: rows, series: names, xLabel: xCol?.label ?? "", scatter: [] as ScatterSeries[], xIsDate: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version, o.xCol, yKey, aggregate, widget.table_ref, chartType, o.splitBy, errKey]);

  // A chart of single records can drive linked widgets: clicking a point selects its record.
  const pickable = aggregate === "none";
  useEffect(() => {
    if (!pickable && selected !== null) useDoc.getState().setCursor(widget.id, null);
  }, [pickable, selected, widget.id]);

  if (link.waiting) return <Empty text="Select a record in the linked widget." />;
  if (chartType === "scatter" ? !scatter.some((s) => s.points.length) : !data.length) return <Empty text="No data to chart yet." />;

  const fmt = (v: unknown) => (typeof v === "number" ? formatNumber(v, { type: "Numeric", options: { decimals: Number.isInteger(v) ? 0 : 2, numMode: "decimal" } }) : String(v));
  const fmtX = (v: unknown) => (xIsDate && typeof v === "number" ? new Date(v).toISOString().slice(0, 10) : fmt(v));
  const color = (i: number) => CHART_COLORS[i % CHART_COLORS.length];
  const hasErr = (s: string) => data.some((r) => r[`${s}__err`] !== undefined);
  const onPick = (state: { activeIndex?: number | string | null } | null) => {
    if (!pickable || state?.activeIndex === undefined || state.activeIndex === null) return;
    const id = data[Number(state.activeIndex)]?._id;
    if (typeof id === "number") useDoc.getState().setCursor(widget.id, id);
  };
  const selIndex = pickable && selected !== null ? data.findIndex((r) => r._id === selected) : -1;
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" />
      <XAxis dataKey="x" tick={{ fontSize: 11 }} name={xLabel} />
      <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={56} reversed={!!o.invertY} />
      <Tooltip formatter={(v) => fmt(v)} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );
  const dot = (i: number) => (o.markers ? { r: 3, fill: color(i), strokeWidth: 0 } : false);

  return (
    <div className={clsx("h-full w-full p-3", pickable && "cursor-pointer")}>
      <ResponsiveContainer width="100%" height="100%">
        {chartType === "pie" ? (
          <PieChart>
            <Pie data={data} dataKey={series[0]} nameKey="x" outerRadius="75%" innerRadius="40%" paddingAngle={1} label={{ fontSize: 11 }}>
              {data.map((_, i) => (
                <Cell key={i} fill={color(i)} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => fmt(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        ) : chartType === "scatter" ? (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" />
            <XAxis type="number" dataKey="x" name={xLabel || "Row"} tick={{ fontSize: 11 }} tickFormatter={fmtX} domain={["auto", "auto"]} />
            <YAxis type="number" dataKey="y" tick={{ fontSize: 11 }} tickFormatter={fmt} width={56} reversed={!!o.invertY} domain={["auto", "auto"]} />
            <Tooltip formatter={(v, name) => (name === (xLabel || "Row") ? fmtX(v) : fmt(v))} />
            {scatter.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {scatter.map((s, i) => (
              <Scatter
                key={s.name}
                name={s.name}
                data={s.points}
                fill={color(i)}
                line={o.connectGaps ? { stroke: color(i), strokeWidth: 1.5 } : false}
                isAnimationActive={false}
                onClick={(p: unknown) => {
                  const pt = p as { _id?: number; payload?: { _id?: number } } | null;
                  const id = pt?._id ?? pt?.payload?._id;
                  if (typeof id === "number") useDoc.getState().setCursor(widget.id, id);
                }}
              >
                {s.points.some((p) => p.err !== undefined) && <ErrorBar dataKey="err" width={4} stroke={color(i)} direction="y" />}
                {s.points.map((p) => (
                  <Cell key={p._id} fill={color(i)} stroke={p._id === selected ? "#111827" : undefined} strokeWidth={p._id === selected ? 2 : 0} />
                ))}
              </Scatter>
            ))}
          </ScatterChart>
        ) : chartType === "line" ? (
          <LineChart data={data} onClick={onPick}>
            {axes}
            {series.map((s, i) => (
              <Line key={s} type="monotone" dataKey={s} stroke={color(i)} strokeWidth={2} dot={dot(i)} connectNulls={!!o.connectGaps} isAnimationActive={false}>
                {hasErr(s) && <ErrorBar dataKey={`${s}__err`} width={4} stroke={color(i)} direction="y" />}
              </Line>
            ))}
          </LineChart>
        ) : chartType === "area" ? (
          <AreaChart data={data} onClick={onPick}>
            {axes}
            {series.map((s, i) => (
              <Area
                key={s}
                type="monotone"
                dataKey={s}
                stackId={o.stacked ? "a" : undefined}
                stroke={color(i)}
                fill={color(i)}
                fillOpacity={0.25}
                dot={dot(i)}
                connectNulls={!!o.connectGaps}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={data} onClick={onPick}>
            {axes}
            {series.map((s, i) => (
              <Bar key={s} dataKey={s} stackId={o.stacked ? "a" : undefined} fill={color(i)} radius={o.invertY ? [0, 0, 3, 3] : [3, 3, 0, 0]} isAnimationActive={false}>
                {hasErr(s) && !o.stacked && <ErrorBar dataKey={`${s}__err`} width={4} stroke="#374151" direction="y" />}
                {selIndex >= 0 && data.map((_, k) => <Cell key={k} fill={color(i)} fillOpacity={k === selIndex ? 1 : 0.45} />)}
              </Bar>
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
  const formulas = widget.options.summaryFormulas ?? [];
  const buckets = widget.options.groupDates ?? {};
  const groupValue = (g: SummaryGroup) => (f: { formula: string }) =>
    engine.evaluateWith(f.formula, widget.table_ref ?? "", g.rowIds[0] ?? -1, { $group: new RecordSet(widget.table_ref ?? "", g.rowIds), group: new RecordSet(widget.table_ref ?? "", g.rowIds) });
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
            {formulas.map((f) => (
              <th key={f.id} className="border-b border-r border-gray-200 px-3 py-2 text-left font-medium" title={f.formula}>
                {f.label || "Formula"}
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
                    {bucketLabel(g.values[k], buckets[c.id]) ?? <CellContent col={c} value={g.values[k]} />}
                  </span>
                </td>
              ))}
              <td className="border-b border-r border-gray-100 px-3 py-1.5 text-right tabular-nums">{g.rowIds.length}</td>
              {sumCols.map((c) => (
                <td key={c.id} className={clsx("border-b border-r border-gray-100 px-3 py-1.5 tabular-nums", isRightAligned(c) && "text-right")}>
                  {formatNumber(total(c, g.rowIds), c)}
                </td>
              ))}
              {formulas.map((f) => {
                const v = groupValue(g)(f);
                return (
                  <td key={f.id} className="border-b border-r border-gray-100 px-3 py-1.5">
                    <span className="flex">
                      <CellContent col={{ ...ANY_COL, table_ref: widget.table_ref ?? "" }} value={v} />
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
          {!groups.length && (
            <tr>
              <td colSpan={groupCols.length + 1 + sumCols.length + formulas.length} className="px-3 py-6 text-center text-gray-400">
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

const ANY_COL: DocColumn = { id: "", doc_id: "", table_ref: "", col_id: "", label: "", type: "Any", is_formula: true, formula: "", options: {}, position: 0 };
