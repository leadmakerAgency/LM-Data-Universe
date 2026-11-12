"use client";

import clsx from "clsx";
import {
  BarChart3,
  CalendarDays,
  ClipboardList,
  Copy,
  Download,
  LayoutGrid,
  Puzzle,
  MoreHorizontal,
  MoveLeft,
  MoveRight,
  Rows3,
  Settings2,
  Sigma,
  SquareStack,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { IconButton, MenuDivider, MenuItem, Popover, useDialogs } from "@/components/ui";
import { CardListWidget, CardWidget } from "./CardWidgets";
import { ChartWidget, SummaryWidget } from "./ChartSummaryWidgets";
import { CalendarWidget } from "./CalendarWidget";
import { CustomWidget } from "./CustomWidget";
import { FormWidget } from "./FormWidget";
import { GridWidget } from "./GridWidget";
import { exportWidgetCsv } from "@/lib/exporter";
import { boundLabel } from "@/lib/view";
import { WIDGET_TYPES, type DocWidget, type WidgetOptions, type WidgetType } from "@/lib/types";
import { useDoc } from "@/store/docStore";
import { useUi, withDraft } from "@/store/uiStore";

export const WIDGET_ICONS: Record<WidgetType, React.ComponentType<{ size?: number; className?: string }>> = {
  table: Table2,
  card: SquareStack,
  card_list: LayoutGrid,
  chart: BarChart3,
  summary: Sigma,
  form: ClipboardList,
  calendar: CalendarDays,
  custom: Puzzle,
};

export function widgetTitle(w: DocWidget): string {
  if (w.title) return w.title;
  const table = w.table_ref ? useDoc.getState().tables.get(w.table_ref)?.table_id : "";
  const label = WIDGET_TYPES.find((t) => t.type === w.type)?.label ?? "";
  return w.type === "table" ? (table ?? label) : `${table ?? ""} ${label}`.trim();
}

export function WidgetBody({ widget, setOptions }: { widget: DocWidget; setOptions: (o: Partial<WidgetOptions>) => void }) {
  switch (widget.type) {
    case "table":
      return <GridWidget widget={widget} setOptions={setOptions} />;
    case "card":
      return <CardWidget widget={widget} />;
    case "card_list":
      return <CardListWidget widget={widget} />;
    case "chart":
      return <ChartWidget widget={widget} />;
    case "summary":
      return <SummaryWidget widget={widget} />;
    case "form":
      return <FormWidget widget={widget} />;
    case "calendar":
      return <CalendarWidget widget={widget} />;
    case "custom":
      return <CustomWidget widget={widget} setOptions={setOptions} />;
  }
}

export function WidgetFrame({ widget: saved, siblings }: { widget: DocWidget; siblings: DocWidget[] }) {
  const draft = useUi((s) => s.drafts[saved.id]);
  const widget = withDraft(saved, draft);
  const activeWidget = useUi((s) => s.activeWidget);
  const setActiveWidget = useUi((s) => s.setActiveWidget);
  const openPanel = useUi((s) => s.openPanel);
  const embed = useUi((s) => s.embed);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const canEdit = (role === "owner" || role === "editor") && !viewingAs;
  const downloadBlocked = useDoc((s) => s.role !== "owner" && !!s.acl?.settings.block_copies);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const { confirm } = useDialogs();
  const Icon = WIDGET_ICONS[widget.type];
  // Sort and filter changes stay unsaved (for this viewer only) until "Save".
  const setOptions = (o: Partial<WidgetOptions>) => {
    const { sort, filters, ...rest } = o;
    if (sort !== undefined || filters !== undefined) {
      const next = { ...(draft ?? {}) };
      if (sort !== undefined) next.sort = sort;
      if (filters !== undefined) next.filters = filters;
      // Back to what's saved: no draft.
      const same = (k: "sort" | "filters") => next[k] === undefined || JSON.stringify(next[k] ?? null) === JSON.stringify(saved.options[k] ?? (k === "sort" ? [] : {}));
      useUi.getState().setDraft(saved.id, same("sort") && same("filters") ? null : next);
    }
    if (Object.keys(rest).length) void useDoc.getState().updateWidget(saved.id, { options: rest });
  };
  const saveDraft = () => {
    if (!draft) return;
    void useDoc.getState().updateWidget(saved.id, { options: draft });
    useUi.getState().setDraft(saved.id, null);
  };
  const sorts = widget.options.sort?.length ?? 0;
  const source = widget.link_source ? useDoc.getState().widgets.get(widget.link_source) : undefined;

  const move = (delta: number) => {
    const i = siblings.findIndex((w) => w.id === widget.id);
    const other = siblings[i + delta];
    if (!other) return;
    void useDoc.getState().updateWidget(widget.id, { position: other.position });
    void useDoc.getState().updateWidget(other.id, { position: widget.position });
  };

  /** Drag the header onto another widget to move this one before or after it. */
  const [dragOver, setDragOver] = useState(false);
  const startMove = (e: React.MouseEvent) => {
    if (!canEdit || e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let target: { id: string; after: boolean } | null = null;
    const mark = (t: typeof target) => {
      document.querySelectorAll("[data-widget-drop]").forEach((el) => el.removeAttribute("data-widget-drop"));
      if (t) document.querySelector(`[data-widget-id="${t.id}"]`)?.setAttribute("data-widget-drop", t.after ? "after" : "before");
    };
    const onMove = (ev: MouseEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      active = true;
      setDragOver(true);
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-widget-id]") as HTMLElement | null;
      const id = el?.dataset.widgetId;
      if (!el || !id || id === widget.id) {
        target = null;
      } else {
        const box = el.getBoundingClientRect();
        target = { id, after: ev.clientX > box.left + box.width / 2 };
      }
      mark(target);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      mark(null);
      setDragOver(false);
      if (!active || !target) return;
      const order = siblings.map((w) => w.id).filter((id) => id !== widget.id);
      const at = order.indexOf(target.id) + (target.after ? 1 : 0);
      order.splice(at, 0, widget.id);
      void useDoc.getState().reorderWidgets(order);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Drag the right edge to change the width (in twelfths of the page). */
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const startWidth = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const section = (e.currentTarget as HTMLElement).closest("section");
    const grid = section?.parentElement;
    if (!section || !grid) return;
    const colW = grid.getBoundingClientRect().width / 12;
    const startX = e.clientX;
    const startW = widget.width;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(2, Math.min(12, Math.round(startW + (ev.clientX - startX) / colW)));
      setLiveWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setLiveWidth(null);
      if (latest !== startW) void useDoc.getState().updateWidget(widget.id, { width: latest });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = widget.height;
    let latest = startH;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(160, Math.min(2000, startH + ev.clientY - startY));
      setLiveHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setLiveHeight(null);
      void useDoc.getState().updateWidget(widget.id, { height: Math.round(latest) });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <section
      data-widget-id={widget.id}
      onMouseDown={() => setActiveWidget(widget.id)}
      style={{ gridColumn: `span ${liveWidth ?? widget.width} / span ${liveWidth ?? widget.width}`, height: liveHeight ?? widget.height }}
      className={clsx(
        "widget-frame relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-white shadow-sm",
        dragOver && "opacity-60",
        activeWidget === widget.id ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200",
      )}
    >
      <header
        className={clsx("flex h-9 shrink-0 items-center gap-2 border-b border-gray-100 px-3", canEdit && "cursor-grab active:cursor-grabbing")}
        onMouseDown={startMove}
        title={canEdit ? "Drag to move this widget" : undefined}
      >
        <Icon size={15} className="text-gray-400" />
        <h3 className="truncate text-sm font-semibold text-gray-800">{widgetTitle(widget)}</h3>
        {source && <span className="truncate text-xs text-gray-400">· linked to {widgetTitle(source)}</span>}
        <div className="flex-1" />
        {draft && (
          <span className="flex items-center gap-1">
            {canEdit && (
              <button className="rounded bg-brand-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-brand-700" onClick={saveDraft} title="Save this sort and filter for everyone">
                Save
              </button>
            )}
            <button className="rounded px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100" onClick={() => useUi.getState().setDraft(saved.id, null)} title="Go back to the saved sort and filter">
              Revert
            </button>
          </span>
        )}
        {sorts > 0 && (
          <Chip onClear={() => setOptions({ sort: [] })} title="Clear sorting">
            <Rows3 size={11} /> Sorted
          </Chip>
        )}
        {Object.entries(widget.options.filters ?? {}).map(([colId, f]) => {
          const c = useDoc.getState().columns.get(colId);
          if (!c) return null;
          const parts: string[] = [];
          if (f.exclude?.length) parts.push(`${f.exclude.length} hidden`);
          if (f.min !== undefined && f.min !== null && f.min !== "") parts.push(`≥ ${boundLabel(f.min)}`);
          if (f.max !== undefined && f.max !== null && f.max !== "") parts.push(`≤ ${boundLabel(f.max)}`);
          return (
            <Chip
              key={colId}
              onClear={() => {
                const next = { ...(widget.options.filters ?? {}) };
                delete next[colId];
                setOptions({ filters: next });
              }}
              title={`Remove the ${c.label || c.col_id} filter`}
            >
              <span className="max-w-40 truncate">
                {c.label || c.col_id}: {parts.join(", ")}
              </span>
            </Chip>
          );
        })}
        {!embed && (
          <>
            <IconButton title="Widget options" onClick={() => openPanel({ tab: "widget", widgetId: widget.id })}>
              <Settings2 size={15} />
            </IconButton>
            <IconButton title="More" onClick={(e) => setMenu(e.currentTarget)}>
              <MoreHorizontal size={16} />
            </IconButton>
          </>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <ErrorBoundary label="This widget couldn't be displayed">
          <WidgetBody widget={widget} setOptions={setOptions} />
        </ErrorBoundary>
      </div>
      {canEdit && <div className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-brand-200" onMouseDown={startResize} />}
      {canEdit && <div className="absolute bottom-0 right-0 top-9 w-1.5 cursor-col-resize hover:bg-brand-200" onMouseDown={startWidth} title="Drag to change the width" />}
      {liveWidth !== null && (
        <div className="pointer-events-none absolute right-2 top-10 rounded bg-gray-900/80 px-1.5 py-0.5 text-[11px] text-white">{liveWidth}/12</div>
      )}

      <Popover anchor={menu} onClose={() => setMenu(null)} align="end">
        <MenuItem icon={<Settings2 size={14} />} onClick={() => (openPanel({ tab: "widget", widgetId: widget.id }), setMenu(null))}>
          Widget options
        </MenuItem>
        {widget.type !== "form" && widget.type !== "custom" && !downloadBlocked && (
          <MenuItem icon={<Download size={14} />} onClick={() => (exportWidgetCsv(widget, widgetTitle(widget)), setMenu(null))}>
            Download as CSV
          </MenuItem>
        )}
        {canEdit && (
          <>
            <MenuDivider />
            {[
              [12, "Full width"],
              [8, "Two thirds"],
              [6, "Half"],
              [4, "One third"],
            ].map(([w, label]) => (
              <MenuItem
                key={w}
                icon={widget.width === w ? <span className="text-brand-600">●</span> : null}
                onClick={() => (useDoc.getState().updateWidget(widget.id, { width: w as number }), setMenu(null))}
              >
                {label}
              </MenuItem>
            ))}
            <MenuDivider />
            <MenuItem icon={<Copy size={14} />} onClick={() => (void useDoc.getState().duplicateWidget(widget.id), setMenu(null))}>
              Duplicate widget
            </MenuItem>
            <MenuItem icon={<MoveLeft size={14} />} onClick={() => (move(-1), setMenu(null))} disabled={siblings[0]?.id === widget.id}>
              Move earlier
            </MenuItem>
            <MenuItem icon={<MoveRight size={14} />} onClick={() => (move(1), setMenu(null))} disabled={siblings[siblings.length - 1]?.id === widget.id}>
              Move later
            </MenuItem>
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={14} />}
              danger
              onClick={async () => {
                setMenu(null);
                const ok = await confirm({
                  title: "Remove widget?",
                  message: "Only this view is removed. The table and its data stay in the document.",
                  confirmLabel: "Remove",
                  danger: true,
                });
                if (ok) await useDoc.getState().deleteWidget(widget.id);
              }}
            >
              Remove widget
            </MenuItem>
          </>
        )}
      </Popover>
    </section>
  );
}

function Chip({ children, onClear, title }: { children: React.ReactNode; onClear: () => void; title: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
      {children}
      <button title={title} onClick={onClear} className="rounded-full hover:bg-brand-100">
        <X size={11} />
      </button>
    </span>
  );
}
