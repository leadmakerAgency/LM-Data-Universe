"use client";

// Board (Kanban): records as cards in stacks by a Choice, Reference or Toggle
// column, optionally in lanes by a second column. Dragging a card to another
// stack changes that cell (one undoable step, which also runs automations);
// dragging it up or down reorders it. Everything a drag does can also be done
// from the card's "Move to…" menu, without dragging.
import clsx from "clsx";
import { ChevronDown, ChevronRight, Clock, EyeOff, Maximize2, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MenuDivider, MenuItem, Popover } from "@/components/ui";
import { ago, groupCards, stackKey, stackValue, stackable, stacksFor, type Stack } from "@/lib/board";
import { choiceColor, displayValue, formatNumber } from "@/lib/format";
import type { CellValue, DocColumn, DocWidget, WidgetOptions } from "@/lib/types";
import { FormulaError, isDate, toNumber, truthy } from "@engine/values";
import { displayCtx, getDerived, tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";
import { useWidgetRows } from "./CardWidgets";
import { RecordTile, tileTitleText } from "./RecordTile";

const STACK_W = 272;
const SHOW = 100;

interface DropTarget {
  stack: string;
  lane: string;
  /** The card the dragged one lands above; null: at the end of the stack. */
  before: number | null;
}

/** Stacks of a Reference column: the records of the table it points at, by their display column. */
function refStacks(col: DocColumn): { id: number; label: string }[] {
  const target = col.options.refTable;
  if (!target) return [];
  const { engine } = getDerived();
  const ctx = displayCtx();
  const cols = tableColumns(target);
  const display = cols.find((c) => c.id === col.options.visibleCol) ?? cols[0];
  return engine
    .rowIds(target)
    .slice(0, 200)
    .map((id) => {
      const v = display ? engine.safeValue(display, id) : null;
      return { id, label: display && !(v instanceof FormulaError) ? displayValue(ctx, display, v) : "" };
    });
}

export function BoardWidget({ widget, setOptions }: { widget: DocWidget; setOptions: (o: Partial<WidgetOptions>) => void }) {
  const { ids, link } = useWidgetRows(widget);
  const role = useDoc((s) => s.role);
  const viewingAs = useDoc((s) => !!s.viewAs);
  const acl = useDoc((s) => s.acl);
  const columns = useDoc((s) => s.columns);
  const selected = useDoc((s) => s.cursors[widget.id] ?? null);
  const o = widget.options;
  const tableRef = widget.table_ref ?? "";
  const editor = (role === "owner" || role === "editor") && !viewingAs;
  const col = o.boardCol ? columns.get(o.boardCol) : undefined;
  const laneCol = o.boardLane ? columns.get(o.boardLane) : undefined;
  const stackCol = col && col.table_ref === tableRef && stackable(col) ? col : undefined;
  const lanesBy = laneCol && laneCol.table_ref === tableRef && stackable(laneCol) && laneCol.id !== stackCol?.id ? laneCol : undefined;
  const writable = (c: DocColumn | undefined) => !!c && !c.is_formula && acl?.cols[c.id]?.update !== false && acl?.tables[tableRef]?.update !== false;
  const canMove = editor && writable(stackCol);
  const sorted = !!o.sort?.length;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem(`lmdu-board-${widget.id}`) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    try {
      window.localStorage.setItem(`lmdu-board-${widget.id}`, JSON.stringify([...next]));
    } catch {
      /* private mode: collapsing lasts for this visit */
    }
  };
  const [more, setMore] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ el: HTMLElement; id: number } | null>(null);
  const [drag, setDrag] = useState<{ id: number; x: number; y: number; target: DropTarget | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const { engine } = getDerived();
  const keyOf = (c: DocColumn, id: number) => stackKey(c, engine.safeValue(c, id));

   
  const model = useMemo(() => {
    if (!stackCol) return null;
    const stackOf = (id: number) => keyOf(stackCol, id);
    const laneOf = lanesBy ? (id: number) => keyOf(lanesBy, id) : null;
    const present = new Set(ids.map(stackOf));
    const stacks = stacksFor(stackCol, stackCol.type === "Ref" ? refStacks(stackCol) : [], present, (c) => choiceColor(stackCol, c));
    const cards = groupCards(ids, stackOf, laneOf);
    let lanes: Stack[] = [{ key: "*", label: "" }];
    if (lanesBy && laneOf) {
      const presentLanes = new Set(ids.map(laneOf));
      lanes = stacksFor(lanesBy, lanesBy.type === "Ref" ? refStacks(lanesBy) : [], presentLanes, (c) => choiceColor(lanesBy, c)).filter((l) => presentLanes.has(l.key));
    }
    const count = (key: string) => [...cards.values()].reduce((n, m) => n + (m.get(key)?.length ?? 0), 0);
    const hidden = new Set(o.boardHidden ?? []);
    const visible = stacks.filter((s) => !hidden.has(s.key) && !(o.boardHideEmpty && count(s.key) === 0));
    return { stacks, visible, lanes, cards, count, hiddenCount: stacks.length - stacks.filter((s) => !hidden.has(s.key)).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, stackCol, lanesBy, o.boardHidden, o.boardHideEmpty, engine]);

  // The selected card follows a "same record" link from another widget.
  useEffect(() => {
    if (link.recordId !== null && ids.includes(link.recordId)) useDoc.getState().setCursor(widget.id, link.recordId);
  }, [link.recordId, ids, widget.id]);

  if (!stackCol || !model) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-sm text-gray-500">
        <p>Choose the column whose values are the stacks.</p>
        <p className="text-xs text-gray-400">Widget options → Board → Stack by (a Choice, Reference or Toggle column).</p>
      </div>
    );
  }
  if (link.waiting) return <div className="flex h-full items-center justify-center text-sm text-gray-400">Select a record in the linked widget.</div>;

  const sumCol = o.boardSum ? columns.get(o.boardSum) : undefined;
  const sinceCol = o.boardSince ? columns.get(o.boardSince) : undefined;
  const total = (list: number[]) => {
    if (!sumCol) return null;
    let n = 0;
    for (const id of list) n += toNumber(engine.safeValue(sumCol, id)) ?? 0;
    return formatNumber(n, sumCol);
  };
  const all = (key: string) => [...model.cards.values()].flatMap((m) => m.get(key) ?? []);
  const stackLabel = (key: string) => model.stacks.find((s) => s.key === key)?.label ?? key;

  /** Puts a card in a stack (and lane), above `before` or at the end. Returns false when a rule says no. */
  const place = (id: number, t: DropTarget): boolean => {
    const values: Record<string, CellValue> = {};
    if (keyOf(stackCol, id) !== t.stack) {
      const rule = o.boardRules?.[t.stack]?.trim();
      if (rule) {
        const ok = engine.evaluate(rule, tableRef, id);
        if (ok instanceof FormulaError || !truthy(ok)) {
          toast.error(`“${tileTitleText(tableRef, id, o)}” can't move to ${stackLabel(t.stack)} yet: ${rule}`);
          return false;
        }
      }
      values[stackCol.id] = stackValue(stackCol, t.stack);
    }
    if (lanesBy && t.lane !== "*" && keyOf(lanesBy, id) !== t.lane) {
      if (!writable(lanesBy)) {
        toast.error(`You can't change ${lanesBy.label || lanesBy.col_id}`);
        return false;
      }
      values[lanesBy.id] = stackValue(lanesBy, t.lane);
    }
    const store = useDoc.getState();
    if (sorted || t.before === id) {
      // A sorted board orders cards itself: only the values change.
      const changes = Object.entries(values).map(([colId, value]) => ({ tableRef, rowId: id, colId, value }));
      if (changes.length) void store.setCells(changes);
    } else {
      void store.moveRows(tableRef, [id], t.before, values);
    }
    return true;
  };

  const startDrag = (e: React.PointerEvent, id: number) => {
    if (!canMove || e.button !== 0 || (e.target as HTMLElement).closest("button, a, input")) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let target: DropTarget | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      active = true;
      target = null;
      const under = document.elementsFromPoint(ev.clientX, ev.clientY) as HTMLElement[];
      const cell = under.find((el) => el.dataset?.boardStack !== undefined && root.current?.contains(el));
      if (cell) {
        const cards = [...cell.querySelectorAll<HTMLElement>("[data-card]")].filter((c) => Number(c.dataset.card) !== id);
        const next = cards.find((c) => {
          const box = c.getBoundingClientRect();
          return ev.clientY < box.top + box.height / 2;
        });
        target = { stack: cell.dataset.boardStack ?? "", lane: cell.dataset.boardLane ?? "*", before: next ? Number(next.dataset.card) : null };
      }
      // Scroll sideways when the card nears an edge.
      const box = root.current?.getBoundingClientRect();
      if (box && root.current) {
        if (ev.clientX > box.right - 40) root.current.scrollLeft += 18;
        else if (ev.clientX < box.left + 40) root.current.scrollLeft -= 18;
      }
      setDrag({ id, x: ev.clientX, y: ev.clientY, target });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDrag(null);
      if (active && target) place(id, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const addCard = async (stack: string, lane: string) => {
    const data: Record<string, CellValue> = { ...(link.newRowDefaults as Record<string, CellValue>), [stackCol.id]: stackValue(stackCol, stack) };
    if (lanesBy && lane !== "*" && writable(lanesBy)) data[lanesBy.id] = stackValue(lanesBy, lane);
    const rows = await useDoc.getState().addRows(tableRef, [{ data }]);
    if (rows[0]) {
      useDoc.getState().setCursor(widget.id, rows[0].id);
      useUi.getState().openRecordCard({ tableRef, rowId: rows[0].id });
    }
  };

  const card = (id: number) => {
    const since = sinceCol ? engine.safeValue(sinceCol, id) : null;
    return (
      <div
        key={id}
        data-card={id}
        tabIndex={0}
        onPointerDown={(e) => startDrag(e, id)}
        onClick={() => useDoc.getState().setCursor(widget.id, id)}
        onDoubleClick={() => useUi.getState().openRecordCard({ tableRef, rowId: id })}
        onKeyDown={(e) => {
          if (e.key === "Enter") useUi.getState().openRecordCard({ tableRef, rowId: id });
          if (e.key === " ") {
            e.preventDefault();
            useDoc.getState().setCursor(widget.id, id);
          }
        }}
        className={clsx(
          "group/card relative select-none rounded-md border bg-white shadow-sm outline-none transition-shadow hover:shadow focus-visible:ring-2 focus-visible:ring-brand-300",
          selected === id ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200",
          canMove && "cursor-grab active:cursor-grabbing",
          drag?.id === id && "opacity-40",
        )}
      >
        <RecordTile
          tableRef={tableRef}
          rowId={id}
          options={o}
          exclude={[stackCol.id, lanesBy?.id, sinceCol?.id]}
          coverHeight={110}
          footer={
            isDate(since) ? (
              <span className="inline-flex items-center gap-0.5" title={`In this stack since ${since.toLocaleString()}`}>
                <Clock size={11} /> {ago(since)}
              </span>
            ) : null
          }
        />
        <div className="absolute right-1 top-1 hidden gap-0.5 rounded bg-white/90 group-focus-within/card:flex group-hover/card:flex">
          <button className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-brand-700" title="Open the record" onClick={() => useUi.getState().openRecordCard({ tableRef, rowId: id })}>
            <Maximize2 size={12} />
          </button>
          {canMove && (
            <button className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-brand-700" title="Move to…" onClick={(e) => setMenu({ el: e.currentTarget, id })}>
              <MoreHorizontal size={13} />
            </button>
          )}
        </div>
      </div>
    );
  };

  const cell = (stack: Stack, lane: string) => {
    const list = model.cards.get(lane)?.get(stack.key) ?? [];
    const shown = more[`${lane}|${stack.key}`] ?? SHOW;
    const over = drag?.target && drag.target.stack === stack.key && drag.target.lane === lane ? drag.target : null;
    if (collapsed.has(stack.key)) return <div key={stack.key} data-board-stack={stack.key} data-board-lane={lane} className={clsx("w-9 shrink-0 rounded-md", over ? "bg-brand-100" : "bg-gray-100/70")} />;
    return (
      <div
        key={stack.key}
        data-board-stack={stack.key}
        data-board-lane={lane}
        className={clsx("flex shrink-0 flex-col gap-2 rounded-md p-2", over ? "bg-brand-50 ring-1 ring-brand-200" : "bg-gray-100/70")}
        style={{ width: STACK_W, minHeight: 64 }}
      >
        {list.slice(0, shown).map((id) => (
          <div key={id}>
            {over && over.before === id && <div className="mb-2 h-0.5 rounded bg-brand-500" />}
            {card(id)}
          </div>
        ))}
        {over && over.before === null && <div className="h-0.5 rounded bg-brand-500" />}
        {list.length > shown && (
          <button className="rounded py-1 text-xs text-brand-700 hover:bg-white" onClick={() => setMore({ ...more, [`${lane}|${stack.key}`]: shown + SHOW })}>
            Show {Math.min(SHOW, list.length - shown)} more of {list.length}
          </button>
        )}
        {editor && writable(stackCol) && (
          <button className="flex items-center gap-1 rounded px-1 py-1 text-xs text-gray-500 hover:bg-white hover:text-brand-700" onClick={() => void addCard(stack.key, lane)}>
            <Plus size={12} /> Add
          </button>
        )}
      </div>
    );
  };

  return (
    <div ref={root} className="scroll-thin h-full overflow-auto bg-white p-3 text-sm">
      <div className="inline-flex min-w-full flex-col gap-2">
        {/* stack headers */}
        <div className="sticky top-0 z-10 flex gap-3 bg-white pb-1">
          {model.visible.map((s) => {
            const list = all(s.key);
            const limit = o.boardWip?.[s.key];
            const overLimit = !!limit && list.length > limit;
            if (collapsed.has(s.key)) {
              return (
                <button key={s.key} className="flex w-9 shrink-0 flex-col items-center gap-1 rounded-md bg-gray-100 py-2 text-xs text-gray-600 hover:bg-gray-200" title={`${s.label}: ${list.length}. Click to expand`} onClick={() => toggle(s.key)}>
                  <ChevronRight size={13} />
                  <span className="font-semibold">{list.length}</span>
                </button>
              );
            }
            return (
              <div key={s.key} className={clsx("flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5", overLimit ? "bg-amber-50" : "bg-gray-50")} style={{ width: STACK_W }}>
                <button className="rounded p-0.5 text-gray-400 hover:bg-gray-200" title="Collapse" onClick={() => toggle(s.key)}>
                  <ChevronDown size={13} />
                </button>
                <span className="truncate rounded px-1.5 py-0.5 text-xs font-semibold text-gray-800" style={{ background: s.color }}>
                  {s.label}
                </span>
                <span className={clsx("text-xs tabular-nums", overLimit ? "font-semibold text-amber-700" : "text-gray-500")} title={limit ? `Limit: ${limit}` : undefined}>
                  {list.length}
                  {limit ? ` / ${limit}` : ""}
                </span>
                <div className="flex-1" />
                {sumCol && <span className="truncate text-xs font-medium tabular-nums text-gray-700" title={`Total ${sumCol.label || sumCol.col_id}`}>{total(list)}</span>}
                {editor && (
                  <button className="rounded p-0.5 text-gray-300 hover:bg-gray-200 hover:text-gray-600" title="Hide this stack" onClick={() => setOptions({ boardHidden: [...(o.boardHidden ?? []), s.key] })}>
                    <EyeOff size={12} />
                  </button>
                )}
              </div>
            );
          })}
          {model.hiddenCount > 0 && (
            <button className="shrink-0 self-center whitespace-nowrap rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100" onClick={() => setOptions({ boardHidden: [] })}>
              Show {model.hiddenCount} hidden
            </button>
          )}
        </div>

        {model.lanes.map((lane) => {
          const laneIds = [...(model.cards.get(lane.key)?.values() ?? [])].flat();
          const laneKey = `lane:${lane.key}`;
          return (
            <div key={lane.key} className="flex flex-col gap-2">
              {lanesBy && (
                <button className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-xs font-semibold text-gray-700 hover:bg-gray-100" onClick={() => toggle(laneKey)}>
                  {collapsed.has(laneKey) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className="rounded px-1.5 py-0.5" style={{ background: lane.color }}>
                    {lane.label}
                  </span>
                  <span className="font-normal text-gray-500">
                    {laneIds.length}
                    {sumCol ? ` · ${total(laneIds)}` : ""}
                  </span>
                </button>
              )}
              {!collapsed.has(laneKey) && <div className="flex items-start gap-3">{model.visible.map((s) => cell(s, lane.key))}</div>}
            </div>
          );
        })}
        {ids.length === 0 && <p className="px-1 py-4 text-sm text-gray-400">No records{Object.keys(o.filters ?? {}).length ? " match the filters" : ""}.</p>}
      </div>

      {drag && (
        <div className="pointer-events-none fixed z-50 w-56 rounded-md border border-brand-300 bg-white px-2.5 py-2 text-sm font-medium shadow-lg" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {tileTitleText(tableRef, drag.id, o)}
        </div>
      )}

      <Popover anchor={menu?.el ?? null} onClose={() => setMenu(null)}>
        {menu && (
          <>
            <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">Move to</div>
            <div className="scroll-thin max-h-64 overflow-y-auto">
              {model.stacks.map((s) => (
                <MenuItem
                  key={s.key}
                  icon={keyOf(stackCol, menu.id) === s.key ? <span className="text-brand-600">●</span> : null}
                  onClick={() => {
                    place(menu.id, { stack: s.key, lane: lanesBy ? keyOf(lanesBy, menu.id) : "*", before: null });
                    setMenu(null);
                  }}
                >
                  {s.label}
                </MenuItem>
              ))}
            </div>
            <MenuDivider />
            <MenuItem icon={<Maximize2 size={14} />} onClick={() => (useUi.getState().openRecordCard({ tableRef, rowId: menu.id }), setMenu(null))}>
              Open the record
            </MenuItem>
          </>
        )}
      </Popover>
    </div>
  );
}
