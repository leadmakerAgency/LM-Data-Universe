"use client";

// One section of the hub (Pipeline, Planning, Files & assets, Clients or an
// added one): saved views as tabs (shared ones are widgets on the section's
// page, personal ones live in user_views), a view switcher, the client filter
// and client list, grouping by client, search, and "+ New".
import clsx from "clsx";
import { Lock, MoreHorizontal, PanelLeft, Plus, Rows3, Search, Settings2, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, MenuDivider, MenuItem, Popover, useDialogs } from "@/components/ui";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { VIEW_TYPES, clientColumn, type HubConfig, type HubSection } from "@/lib/hub";
import { errorMessage, supabase } from "@/lib/supabase";
import type { CellValue, DocWidget, WidgetOptions, WidgetType } from "@/lib/types";
import { viewDefaults } from "@/lib/widgetDefaults";
import { tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";
import { WIDGET_ICONS, WidgetBody } from "../doc/WidgetFrame";
import { ClientPicker, ClientRail } from "./ClientPicker";

interface UserView {
  id: string;
  doc_id: string;
  page_id: string;
  name: string;
  type: WidgetType;
  options: WidgetOptions;
  position: number;
}

/** Options a view of `type` needs, filled in where missing. */
export function optionsFor(type: WidgetType, tableRef: string, current: WidgetOptions): WidgetOptions {
  const cols = tableColumns(tableRef);
  const extra: WidgetOptions = { ...viewDefaults(type, cols, tableRef) };
  if (type === "calendar") {
    const dates = cols.filter((c) => c.type === "Date" || c.type === "DateTime");
    Object.assign(extra, { calStart: dates[0]?.id ?? null, calEnd: dates[1]?.id ?? null, calTitle: cols.find((c) => c.type === "Text")?.id ?? null, calView: "month" });
  }
  const out: WidgetOptions = { ...current };
  for (const [k, v] of Object.entries(extra)) if ((out as Record<string, unknown>)[k] === undefined || (out as Record<string, unknown>)[k] === null) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function SectionView({
  section,
  config,
  client,
  setClient,
  viewParam,
  setViewParam,
}: {
  section: HubSection;
  config: HubConfig;
  client: number | null;
  setClient: (id: number | null) => void;
  viewParam: string | null;
  setViewParam: (id: string | null) => void;
}) {
  const docId = useDoc((s) => s.docId)!;
  const widgets = useDoc((s) => s.widgets);
  const role = useDoc((s) => s.role);
  useDoc((s) => s.version);
  const canEdit = role === "owner" || role === "editor";
  const { prompt, confirm } = useDialogs();
  const [mine, setMine] = useState<UserView[]>([]);
  const [rail, setRail] = useState(() => {
    try {
      return window.localStorage.getItem("lmdu-client-rail") === "1";
    } catch {
      return false;
    }
  });
  const [query, setQuery] = useState("");
  const [newMenu, setNewMenu] = useState<HTMLElement | null>(null);
  const [tabMenu, setTabMenu] = useState<HTMLElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shared = useMemo(() => [...widgets.values()].filter((w) => w.page_id === section.page).sort((a, b) => a.position - b.position), [widgets, section.page]);
  const cols = tableColumns(section.table);
  const clientCol = section.key === "clients" ? undefined : clientColumn(cols, config.clients);

  useEffect(() => {
    let live = true;
    void supabase()
      .from("user_views")
      .select("*")
      .eq("page_id", section.page)
      .order("position")
      .then(({ data }) => live && setMine((data as UserView[] | null) ?? []));
    return () => {
      live = false;
    };
  }, [section.page]);

  // The view shown: the one in the address, else the first.
  const asWidget = useCallback(
    (v: UserView): DocWidget => ({ id: `uv-${v.id}`, doc_id: docId, page_id: v.page_id, table_ref: section.table, type: v.type, title: v.name, position: v.position, width: 12, height: 600, options: v.options, link_source: null, link_col: null }),
    [docId, section.table],
  );
  const current: DocWidget | undefined =
    shared.find((w) => w.id === viewParam) ?? (viewParam?.startsWith("uv-") ? mine.map(asWidget).find((w) => w.id === viewParam) : undefined) ?? shared[0] ?? (mine[0] ? asWidget(mine[0]) : undefined);
  const personal = !!current?.id.startsWith("uv-");

  // Search: the views filter by the search box of the widget that is active.
  useEffect(() => {
    if (!current) return;
    useUi.getState().setActiveWidget(current.id);
    useUi.getState().setSearch(query);
  }, [current, query]);
  useEffect(() => () => useUi.getState().setSearch(""), []);

  const setOptions = (patch: Partial<WidgetOptions>) => {
    if (!current) return;
    if (!personal) {
      void useDoc.getState().updateWidget(current.id, { options: patch });
      return;
    }
    const id = current.id.slice(3);
    setMine((list) => list.map((v) => (v.id === id ? { ...v, options: { ...v.options, ...patch } } : v)));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const v = mine.find((x) => x.id === id);
      if (v) void supabase().from("user_views").update({ options: { ...v.options, ...patch } }).eq("id", id);
    }, 600);
  };

  const setType = (type: WidgetType) => {
    if (!current || current.type === type) return;
    const options = optionsFor(type, section.table, current.options);
    if (!personal) void useDoc.getState().updateWidget(current.id, { type, options });
    else {
      const id = current.id.slice(3);
      setMine((list) => list.map((v) => (v.id === id ? { ...v, type, options } : v)));
      void supabase().from("user_views").update({ type, options }).eq("id", id);
    }
  };

  const newView = async (forEveryone: boolean) => {
    setNewMenu(null);
    const name = (await prompt({ title: forEveryone ? "New view for everyone" : "New personal view", label: "Name", initial: "", confirmLabel: "Create" }))?.trim();
    if (!name) return;
    const type = current?.type ?? "table";
    const options = optionsFor(type, section.table, { ...(current?.options ?? {}), viewName: name });
    if (forEveryone) {
      const w = await useDoc.getState().addWidget(section.page, { type, tableRef: section.table, title: name, width: 12 });
      if (w) {
        await useDoc.getState().updateWidget(w.id, { options, height: 600 });
        setViewParam(w.id);
      }
    } else {
      const { data, error } = await supabase()
        .from("user_views")
        .insert({ doc_id: docId, page_id: section.page, name, type, options, position: Date.now() / 1e10 })
        .select()
        .single();
      if (error) return toast.error(errorMessage(error));
      setMine((l) => [...l, data as UserView]);
      setViewParam(`uv-${(data as UserView).id}`);
    }
  };

  const renameView = async () => {
    setTabMenu(null);
    if (!current) return;
    const name = (await prompt({ title: "Rename view", label: "Name", initial: current.title, confirmLabel: "Rename" }))?.trim();
    if (!name) return;
    if (!personal) void useDoc.getState().updateWidget(current.id, { title: name });
    else {
      const id = current.id.slice(3);
      setMine((l) => l.map((v) => (v.id === id ? { ...v, name } : v)));
      void supabase().from("user_views").update({ name }).eq("id", id);
    }
  };

  const deleteView = async () => {
    setTabMenu(null);
    if (!current) return;
    if (!personal && shared.length <= 1) return toast.info("A section keeps at least one shared view.");
    if (!(await confirm({ title: `Delete the view “${current.title}”?`, message: "Only the view goes; the records stay.", confirmLabel: "Delete", danger: true }))) return;
    if (!personal) await useDoc.getState().deleteWidget(current.id);
    else {
      const id = current.id.slice(3);
      await supabase().from("user_views").delete().eq("id", id);
      setMine((l) => l.filter((v) => v.id !== id));
    }
    setViewParam(null);
  };

  const addRecord = async () => {
    const data: Record<string, CellValue> = {};
    if (clientCol && client) data[clientCol.id] = clientCol.type === "RefList" ? [client] : client;
    const made = await useDoc.getState().addRows(section.table, [{ data }]);
    if (made[0]) useUi.getState().openRecordCard({ tableRef: section.table, rowId: made[0].id });
  };

  const toggleRail = () => {
    setRail(!rail);
    try {
      window.localStorage.setItem("lmdu-client-rail", rail ? "0" : "1");
    } catch {
      /* not remembered */
    }
  };

  // Grouping by client: a lane per client on boards, a group on timelines, a section in galleries.
  const groupKey: keyof WidgetOptions | null = current?.type === "board" ? "boardLane" : current?.type === "timeline" ? "tlGroup" : current?.type === "gallery" ? "galGroup" : null;
  const grouped = !!(groupKey && clientCol && current && current.options[groupKey] === clientCol.id);

  const shown: DocWidget | undefined = current && {
    ...current,
    options: { ...current.options, onlyRef: client && clientCol ? { col: clientCol.id, id: client } : null },
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-gray-200 bg-white px-5 pt-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{section.label}</h1>
          <div className="flex-1" />
          {canEdit && (
            <Button variant="primary" onClick={() => void addRecord()}>
              <Plus size={14} /> {section.noun}
            </Button>
          )}
        </div>
        <div className="mt-3 flex items-end gap-1 overflow-x-auto" role="tablist" aria-label="Views">
          {[...shared, ...mine.map(asWidget)].map((w) => {
            const Icon = WIDGET_ICONS[w.type];
            const on = current?.id === w.id;
            return (
              <button
                key={w.id}
                role="tab"
                aria-selected={on}
                onClick={() => setViewParam(w.id)}
                className={clsx("-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm", on ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-gray-600 hover:text-gray-900")}
              >
                <Icon size={14} className="opacity-70" />
                {w.title || "View"}
                {w.id.startsWith("uv-") && <Lock size={11} className="text-gray-400" aria-label="Only you see this view" />}
              </button>
            );
          })}
          <button className="-mb-px shrink-0 rounded px-2 py-1.5 text-sm text-gray-500 hover:text-brand-700" onClick={(e) => setNewMenu(e.currentTarget)} title="Add a view">
            <Plus size={14} />
          </button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 bg-white px-5 py-2">
        {clientCol && (
          <>
            <button className={clsx("rounded p-1.5", rail ? "bg-brand-50 text-brand-700" : "text-gray-500 hover:bg-gray-100")} title={rail ? "Hide the client list" : "Show the client list"} onClick={toggleRail}>
              <PanelLeft size={15} />
            </button>
            <ClientPicker clientsTable={config.clients} col={clientCol} value={client} onChange={setClient} />
          </>
        )}
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search" className="h-8 w-52 rounded-md border border-gray-300 pl-7 pr-2 text-sm outline-none focus:border-brand-500" />
        </div>
        <div className="flex-1" />
        {groupKey && clientCol && (
          <button
            className={clsx("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm", grouped ? "border-brand-300 bg-brand-50 text-brand-800" : "border-gray-300 text-gray-700 hover:bg-gray-50")}
            onClick={() => setOptions({ [groupKey]: grouped ? null : clientCol.id } as Partial<WidgetOptions>)}
            title="Group by client"
          >
            <Users size={14} /> Group by client
          </button>
        )}
        <div className="flex h-8 items-center rounded-md border border-gray-300 p-0.5" role="group" aria-label="Show as">
          {VIEW_TYPES.map((t) => {
            const Icon = WIDGET_ICONS[t.type];
            return (
              <button
                key={t.type}
                title={t.label}
                aria-pressed={current?.type === t.type}
                onClick={() => setType(t.type)}
                disabled={!current || (!personal && !canEdit)}
                className={clsx("rounded px-2 py-1 text-xs", current?.type === t.type ? "bg-brand-50 font-medium text-brand-700" : "text-gray-600 hover:bg-gray-100 disabled:opacity-50")}
              >
                <Icon size={14} />
              </button>
            );
          })}
        </div>
        {current && (
          <button className="rounded p-1.5 text-gray-500 hover:bg-gray-100" title="This view" onClick={(e) => setTabMenu(e.currentTarget)}>
            <MoreHorizontal size={16} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {rail && clientCol && <ClientRail clientsTable={config.clients} col={clientCol} value={client} onChange={setClient} />}
        <div className="min-w-0 flex-1 bg-white">
          {shown ? (
            <ErrorBoundary label="This view couldn't be displayed">
              <WidgetBody key={shown.id} widget={shown} setOptions={setOptions} />
            </ErrorBoundary>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">No views yet.</div>
          )}
        </div>
      </div>

      <Popover anchor={newMenu} onClose={() => setNewMenu(null)}>
        {canEdit && (
          <MenuItem icon={<Rows3 size={14} />} onClick={() => void newView(true)}>
            New view for everyone
          </MenuItem>
        )}
        <MenuItem icon={<Lock size={14} />} onClick={() => void newView(false)}>
          New personal view
        </MenuItem>
      </Popover>
      <Popover anchor={tabMenu} onClose={() => setTabMenu(null)} align="end">
        {current && !personal && canEdit && (
          <MenuItem icon={<Settings2 size={14} />} onClick={() => (setTabMenu(null), useUi.getState().openPanel({ tab: "widget", widgetId: current.id }))}>
            View options (columns, stacks, dates…)
          </MenuItem>
        )}
        {(personal || canEdit) && (
          <>
            <MenuItem onClick={() => void renameView()}>Rename</MenuItem>
            <MenuDivider />
            <MenuItem danger onClick={() => void deleteView()}>
              Delete view
            </MenuItem>
          </>
        )}
        {!personal && !canEdit && <div className="px-3 py-2 text-xs text-gray-500">Shared views are changed by editors. Make a personal view to set your own.</div>}
      </Popover>
    </div>
  );
}
