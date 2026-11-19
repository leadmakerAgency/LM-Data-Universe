"use client";

// Widget options for Board, Timeline and Gallery, and for the tile they draw records with.
import { ArrowDown, ArrowUp, Clock, X } from "lucide-react";
import { useState } from "react";
import { IconButton, Label, Select } from "@/components/ui";
import { stackable } from "@/lib/board";
import type { DocColumn, DocWidget, TimelineZoom, WidgetOptions } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";
import { tileFieldColumns } from "./RecordTile";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 px-4 py-4">
      <Label className="mb-2">{title}</Label>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Pick({
  label,
  value,
  cols,
  none,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  cols: DocColumn[];
  none?: string;
  disabled: boolean;
  onChange: (id: string | null) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-gray-500">{label}</div>
      <Select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        {none !== undefined && <option value="">{none}</option>}
        {cols.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label || c.col_id}
          </option>
        ))}
      </Select>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/** A small text box that saves when left (or on Enter). */
function Commit({ value, onCommit, placeholder, disabled, mono, type }: { value: string; onCommit: (v: string) => void; placeholder?: string; disabled?: boolean; mono?: boolean; type?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type={type ?? "text"}
      value={draft ?? value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`h-7 w-full rounded border border-gray-300 px-2 text-xs outline-none focus:border-brand-500 ${mono ? "font-mono" : ""}`}
    />
  );
}

export function ViewOptions({ widget, canEdit, setOpt }: { widget: DocWidget; canEdit: boolean; setOpt: (patch: Partial<WidgetOptions>) => void }) {
  useDoc((s) => s.version);
  const o = widget.options;
  const tableRef = widget.table_ref;
  const cols = tableColumns(tableRef);
  const numbers = cols.filter((c) => c.type === "Numeric" || c.type === "Int");
  const dates = cols.filter((c) => c.type === "Date" || c.type === "DateTime");
  const files = cols.filter((c) => c.type === "Attachments");
  const stackCols = cols.filter(stackable);
  const stackCol = cols.find((c) => c.id === o.boardCol);
  const stackKeys = stackCol?.type === "Choice" ? (stackCol.options.choices ?? []).map((c) => ({ key: c, label: c })) : stackCol?.type === "Bool" ? [{ key: "false", label: "No" }, { key: "true", label: "Yes" }] : [];
  const shown = tileFieldColumns(tableRef, o, [o.boardCol, o.boardLane]);
  const shownIds = shown.map((c) => c.id);

  const trackTime = async () => {
    if (!tableRef || !stackCol) return;
    const created = await useDoc.getState().addColumn(tableRef, {
      label: `${stackCol.label || stackCol.col_id} since`,
      type: "DateTime",
      formula: "NOW()",
      options: { trigger: { onNew: true, onChange: [stackCol.id] } },
    });
    if (created) setOpt({ boardSince: created.id });
  };

  return (
    <>
      {widget.type === "board" && (
        <Section title="Board">
          <Pick label="Stack by" value={o.boardCol} cols={stackCols} none="Choose a column" disabled={!canEdit} onChange={(boardCol) => setOpt({ boardCol, boardHidden: [], boardWip: {}, boardRules: {} })} hint={stackCols.length ? undefined : "Needs a Choice, Reference or Toggle column."} />
          <Pick label="Lanes (a second grouping)" value={o.boardLane} cols={stackCols.filter((c) => c.id !== o.boardCol)} none="No lanes" disabled={!canEdit} onChange={(boardLane) => setOpt({ boardLane })} />
          <Pick label="Total in each stack" value={o.boardSum} cols={numbers} none="None" disabled={!canEdit} onChange={(boardSum) => setOpt({ boardSum })} />
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!canEdit} checked={!!o.boardHideEmpty} onChange={(e) => setOpt({ boardHideEmpty: e.target.checked })} /> Hide empty stacks
          </label>
          {(o.boardHidden?.length ?? 0) > 0 && (
            <button className="text-xs text-brand-600 hover:underline" onClick={() => setOpt({ boardHidden: [] })}>
              Show the {o.boardHidden!.length} hidden stack{o.boardHidden!.length === 1 ? "" : "s"}
            </button>
          )}
          {stackKeys.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-gray-500">Per stack: a limit, and a condition to enter</div>
              <div className="space-y-1.5">
                {stackKeys.map((s) => (
                  <div key={s.key} className="grid grid-cols-[1fr_3.5rem] items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{s.label}</span>
                    <Commit
                      type="number"
                      disabled={!canEdit}
                      placeholder="limit"
                      value={o.boardWip?.[s.key] ? String(o.boardWip[s.key]) : ""}
                      onCommit={(v) => {
                        const next = { ...(o.boardWip ?? {}) };
                        const n = Math.floor(Number(v));
                        if (n > 0) next[s.key] = n;
                        else delete next[s.key];
                        setOpt({ boardWip: next });
                      }}
                    />
                    <div className="col-span-2">
                      <Commit
                        mono
                        disabled={!canEdit}
                        placeholder="e.g. $Amount > 0 and len($Contract) > 0"
                        value={o.boardRules?.[s.key] ?? ""}
                        onCommit={(v) => {
                          const next = { ...(o.boardRules ?? {}) };
                          if (v.trim()) next[s.key] = v.trim();
                          else delete next[s.key];
                          setOpt({ boardRules: next });
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-xs text-gray-500">A card can only be moved into a stack when its condition is true for that record.</p>
            </div>
          )}
          <div>
            <Pick label="Time in the stack" value={o.boardSince} cols={dates.filter((c) => c.type === "DateTime")} none="Don't show" disabled={!canEdit} onChange={(boardSince) => setOpt({ boardSince })} />
            {canEdit && stackCol && !o.boardSince && (
              <button className="mt-1 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline" onClick={() => void trackTime()}>
                <Clock size={11} /> Add a column that records when the stack changes
              </button>
            )}
          </div>
        </Section>
      )}

      {widget.type === "gallery" && (
        <Section title="Gallery">
          <div>
            <div className="mb-1 text-xs text-gray-500">Show</div>
            <Select value={o.galMode ?? "records"} disabled={!canEdit} onChange={(e) => setOpt({ galMode: e.target.value as WidgetOptions["galMode"] })}>
              <option value="records">One tile per record</option>
              <option value="files">One tile per file</option>
            </Select>
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">Tile size</div>
            <Select value={o.galSize ?? "medium"} disabled={!canEdit} onChange={(e) => setOpt({ galSize: e.target.value as WidgetOptions["galSize"] })}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </Select>
          </div>
          <Pick label="Group into sections by" value={o.galGroup} cols={cols.filter((c) => c.type !== "Attachments")} none="No sections" disabled={!canEdit} onChange={(galGroup) => setOpt({ galGroup })} />
        </Section>
      )}

      {widget.type === "timeline" && (
        <Section title="Timeline">
          <Pick label="Starts" value={o.tlStart} cols={dates} none="Choose a date column" disabled={!canEdit} onChange={(tlStart) => setOpt({ tlStart })} hint={dates.length ? undefined : "Needs a Date or DateTime column."} />
          <Pick label="Ends" value={o.tlEnd} cols={dates.filter((c) => c.id !== o.tlStart)} none="No end (milestones)" disabled={!canEdit} onChange={(tlEnd) => setOpt({ tlEnd })} />
          <Pick label="Group rows by" value={o.tlGroup} cols={cols.filter((c) => c.type === "Choice" || c.type === "Ref" || c.type === "Bool" || c.type === "Text")} none="No groups" disabled={!canEdit} onChange={(tlGroup) => setOpt({ tlGroup })} />
          <Pick
            label="Waits for (dependencies)"
            value={o.tlDeps}
            cols={cols.filter((c) => c.type === "RefList" && !c.is_formula && c.options.refTable === tableRef)}
            none="None"
            disabled={!canEdit}
            onChange={(tlDeps) => setOpt({ tlDeps })}
            hint="A Reference List column pointing at this same table: the records that must finish first."
          />
          <Pick label="Progress" value={o.tlProgress} cols={numbers} none="None" disabled={!canEdit} onChange={(tlProgress) => setOpt({ tlProgress })} />
          <div>
            <div className="mb-1 text-xs text-gray-500">Zoom</div>
            <Select value={o.tlZoom ?? "week"} onChange={(e) => setOpt({ tlZoom: e.target.value as TimelineZoom })}>
              <option value="day">Days</option>
              <option value="week">Weeks</option>
              <option value="month">Months</option>
              <option value="quarter">Quarters</option>
              <option value="year">Years</option>
            </Select>
          </div>
        </Section>
      )}

      <Section title={widget.type === "timeline" ? "Bars" : "Tiles"}>
        <Pick label="Title" value={o.tileTitle} cols={cols.filter((c) => c.type !== "Attachments")} none="First text column" disabled={!canEdit} onChange={(tileTitle) => setOpt({ tileTitle })} />
        <Pick label="Colour by" value={o.tileColor} cols={cols.filter((c) => c.type === "Choice")} none="None" disabled={!canEdit} onChange={(tileColor) => setOpt({ tileColor })} />
        {widget.type !== "timeline" && (
          <>
            <Pick label="Cover" value={o.tileCover} cols={files} none="No cover" disabled={!canEdit} onChange={(tileCover) => setOpt({ tileCover })} hint={files.length ? undefined : "Add an Attachments column to show images or files."} />
            {o.tileCover && (
              <label className="flex items-center gap-2">
                <input type="checkbox" disabled={!canEdit} checked={o.tileCoverFit === "fit"} onChange={(e) => setOpt({ tileCoverFit: e.target.checked ? "fit" : "crop" })} /> Show the whole image (don&apos;t crop)
              </label>
            )}
            <div>
              <div className="mb-1 text-xs text-gray-500">Fields on the tile</div>
              <ul className="space-y-0.5">
                {shown.map((c, i) => (
                  <li key={c.id} className="flex items-center gap-1">
                    <span className="flex-1 truncate">{c.label || c.col_id}</span>
                    <IconButton title="Move up" disabled={!canEdit || i === 0} onClick={() => setOpt({ tileFields: shownIds.map((id, k) => (k === i - 1 ? shownIds[i] : k === i ? shownIds[i - 1] : id)) })}>
                      <ArrowUp size={12} />
                    </IconButton>
                    <IconButton title="Move down" disabled={!canEdit || i === shown.length - 1} onClick={() => setOpt({ tileFields: shownIds.map((id, k) => (k === i + 1 ? shownIds[i] : k === i ? shownIds[i + 1] : id)) })}>
                      <ArrowDown size={12} />
                    </IconButton>
                    <IconButton title="Remove" disabled={!canEdit} onClick={() => setOpt({ tileFields: shownIds.filter((id) => id !== c.id) })}>
                      <X size={12} />
                    </IconButton>
                  </li>
                ))}
              </ul>
              <Select className="mt-1" value="" disabled={!canEdit} onChange={(e) => e.target.value && setOpt({ tileFields: [...shownIds, e.target.value] })}>
                <option value="">+ Add a field</option>
                {cols
                  .filter((c) => !shownIds.includes(c.id) && c.id !== o.tileTitle)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label || c.col_id}
                    </option>
                  ))}
              </Select>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" disabled={!canEdit} checked={!!o.tileLabels} onChange={(e) => setOpt({ tileLabels: e.target.checked })} /> Show field names
            </label>
          </>
        )}
      </Section>
    </>
  );
}
