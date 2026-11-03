"use client";

import clsx from "clsx";
import {
  BarChart3,
  ClipboardList,
  Download,
  LayoutGrid,
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
import { FormWidget } from "./FormWidget";
import { GridWidget } from "./GridWidget";
import { exportWidgetCsv } from "@/lib/exporter";
import { WIDGET_TYPES, type DocWidget, type WidgetOptions, type WidgetType } from "@/lib/types";
import { useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

export const WIDGET_ICONS: Record<WidgetType, React.ComponentType<{ size?: number; className?: string }>> = {
  table: Table2,
  card: SquareStack,
  card_list: LayoutGrid,
  chart: BarChart3,
  summary: Sigma,
  form: ClipboardList,
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
  }
}

export function WidgetFrame({ widget, siblings }: { widget: DocWidget; siblings: DocWidget[] }) {
  const activeWidget = useUi((s) => s.activeWidget);
  const setActiveWidget = useUi((s) => s.setActiveWidget);
  const openPanel = useUi((s) => s.openPanel);
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const { confirm } = useDialogs();
  const Icon = WIDGET_ICONS[widget.type];
  const setOptions = (o: Partial<WidgetOptions>) => void useDoc.getState().updateWidget(widget.id, { options: o });
  const sorts = widget.options.sort?.length ?? 0;
  const filters = Object.keys(widget.options.filters ?? {}).length;
  const source = widget.link_source ? useDoc.getState().widgets.get(widget.link_source) : undefined;

  const move = (delta: number) => {
    const i = siblings.findIndex((w) => w.id === widget.id);
    const other = siblings[i + delta];
    if (!other) return;
    void useDoc.getState().updateWidget(widget.id, { position: other.position });
    void useDoc.getState().updateWidget(other.id, { position: widget.position });
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
      onMouseDown={() => setActiveWidget(widget.id)}
      style={{ gridColumn: `span ${widget.width} / span ${widget.width}`, height: liveHeight ?? widget.height }}
      className={clsx(
        "relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-white shadow-sm",
        activeWidget === widget.id ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200",
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-gray-100 px-3">
        <Icon size={15} className="text-gray-400" />
        <h3 className="truncate text-sm font-semibold text-gray-800">{widgetTitle(widget)}</h3>
        {source && <span className="truncate text-xs text-gray-400">· linked to {widgetTitle(source)}</span>}
        <div className="flex-1" />
        {sorts > 0 && (
          <Chip onClear={() => setOptions({ sort: [] })} title="Clear sorting">
            <Rows3 size={11} /> Sorted
          </Chip>
        )}
        {filters > 0 && (
          <Chip onClear={() => setOptions({ filters: {} })} title="Clear filters">
            {filters} filter{filters > 1 ? "s" : ""}
          </Chip>
        )}
        <IconButton title="Widget options" onClick={() => openPanel({ tab: "widget", widgetId: widget.id })}>
          <Settings2 size={15} />
        </IconButton>
        <IconButton title="More" onClick={(e) => setMenu(e.currentTarget)}>
          <MoreHorizontal size={16} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">
        <ErrorBoundary label="This widget couldn't be displayed">
          <WidgetBody widget={widget} setOptions={setOptions} />
        </ErrorBoundary>
      </div>
      {canEdit && <div className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-brand-200" onMouseDown={startResize} />}

      <Popover anchor={menu} onClose={() => setMenu(null)} align="end">
        <MenuItem icon={<Settings2 size={14} />} onClick={() => (openPanel({ tab: "widget", widgetId: widget.id }), setMenu(null))}>
          Widget options
        </MenuItem>
        {widget.type !== "form" && (
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
