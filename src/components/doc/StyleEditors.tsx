"use client";

import clsx from "clsx";
import { Bold, ChevronDown, ChevronUp, Italic, Plus, Strikethrough, Trash2, Underline } from "lucide-react";
import { useState } from "react";
import { Button, IconButton, Input, Popover } from "@/components/ui";
import { STYLE_COLORS, newRule, ruleMatches, styleToCss } from "@/lib/styles";
import type { CellStyle, StyleRule } from "@/lib/types";
import { getDerived } from "@/store/docStore";

function ColorPick({ label, value, onChange, disabled }: { label: string; value?: string; onChange: (v: string | undefined) => void; disabled?: boolean }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        disabled={disabled}
        onClick={(e) => setEl(e.currentTarget)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-gray-200 px-2 text-xs hover:bg-gray-50 disabled:opacity-50"
        title={label}
      >
        <span className="h-3.5 w-3.5 rounded border border-gray-300" style={{ background: value ?? "transparent" }} />
        {label}
      </button>
      <Popover anchor={el} onClose={() => setEl(null)}>
        <div className="w-48 p-2">
          <div className="grid grid-cols-8 gap-1">
            {STYLE_COLORS.map((c) => (
              <button
                key={c}
                className={clsx("h-5 w-5 rounded border", value === c ? "ring-2 ring-brand-500" : "border-gray-300")}
                style={{ background: c }}
                onClick={() => {
                  onChange(c);
                  setEl(null);
                }}
                title={c}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <Input
              defaultValue={value ?? ""}
              placeholder="#hex"
              className="h-7 font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (/^#[0-9a-f]{3,8}$/i.test(v)) onChange(v);
                  setEl(null);
                }
              }}
            />
            <Button
              size="sm"
              onClick={() => {
                onChange(undefined);
                setEl(null);
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** Text colour, fill colour and bold / italic / underline / strikethrough. */
export function StyleEditor({ value, onChange, disabled }: { value: CellStyle | undefined; onChange: (s: CellStyle) => void; disabled?: boolean }) {
  const s = value ?? {};
  const set = (patch: Partial<CellStyle>) => {
    const next: CellStyle = { ...s, ...patch };
    for (const k of Object.keys(next) as (keyof CellStyle)[]) if (next[k] === undefined || next[k] === false) delete next[k];
    onChange(next);
  };
  const toggle = (k: "bold" | "italic" | "underline" | "strike", icon: React.ReactNode, title: string) => (
    <button
      disabled={disabled}
      title={title}
      onClick={() => set({ [k]: !s[k] })}
      className={clsx("flex h-7 w-7 items-center justify-center rounded-md border text-gray-600", s[k] ? "border-brand-400 bg-brand-50 text-brand-700" : "border-gray-200 hover:bg-gray-50")}
    >
      {icon}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ColorPick label="Text" value={s.textColor} onChange={(v) => set({ textColor: v })} disabled={disabled} />
      <ColorPick label="Fill" value={s.fillColor} onChange={(v) => set({ fillColor: v })} disabled={disabled} />
      {toggle("bold", <Bold size={13} />, "Bold")}
      {toggle("italic", <Italic size={13} />, "Italic")}
      {toggle("underline", <Underline size={13} />, "Underline")}
      {toggle("strike", <Strikethrough size={13} />, "Strikethrough")}
    </div>
  );
}

/** Ordered list of conditional styles: a formula and the style it applies. */
export function RulesEditor({
  rules,
  tableRef,
  onChange,
  disabled,
  placeholder = '$Status == "Done"',
}: {
  rules: StyleRule[];
  tableRef: string;
  onChange: (rules: StyleRule[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const update = (id: string, patch: Partial<StyleRule>) => onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) => {
    const next = [...rules];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r);
    onChange(next);
  };
  const ids = getDerived().engine.rowIds(tableRef);
  return (
    <div className="space-y-2">
      {rules.map((r, i) => {
        const hits = r.formula.trim() ? ids.filter((id) => ruleMatches(r, tableRef, id)).length : 0;
        const first = r.formula.trim() && ids.length ? getDerived().engine.evaluate(r.formula, tableRef, ids[0]) : null;
        const error = first instanceof Error ? first.message : null;
        return (
          <div key={r.id} className="space-y-1.5 rounded-md border border-gray-200 p-2">
            <div className="flex items-center gap-1">
              <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={styleToCss(r.style)}>
                Rule {i + 1}
              </span>
              <span className="flex-1 text-[11px] text-gray-400">{r.formula.trim() ? `${hits} of ${ids.length} rows` : ""}</span>
              {!disabled && (
                <>
                  <IconButton title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ChevronUp size={13} />
                  </IconButton>
                  <IconButton title="Later" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                    <ChevronDown size={13} />
                  </IconButton>
                  <IconButton title="Delete rule" onClick={() => onChange(rules.filter((x) => x.id !== r.id))}>
                    <Trash2 size={13} />
                  </IconButton>
                </>
              )}
            </div>
            <RuleFormula value={r.formula} placeholder={placeholder} disabled={disabled} onCommit={(formula) => update(r.id, { formula })} />
            {error && <div className="truncate text-[11px] text-red-600" title={error}>{error}</div>}
            <StyleEditor value={r.style} onChange={(style) => update(r.id, { style })} disabled={disabled} />
          </div>
        );
      })}
      {!disabled && (
        <Button size="sm" onClick={() => onChange([...rules, newRule()])}>
          <Plus size={13} /> Add conditional style
        </Button>
      )}
    </div>
  );
}

function RuleFormula({ value, onCommit, disabled, placeholder }: { value: string; onCommit: (v: string) => void; disabled?: boolean; placeholder: string }) {
  const [text, setText] = useState(value);
  return (
    <div className="flex items-start rounded-md border border-gray-300 focus-within:border-brand-500">
      <span className="select-none py-1.5 pl-2 font-mono text-xs font-semibold text-brand-600">=</span>
      <textarea
        value={text}
        disabled={disabled}
        rows={Math.min(5, Math.max(1, text.split("\n").length))}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onCommit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        className="w-full resize-none bg-transparent p-1.5 font-mono text-xs outline-none"
      />
    </div>
  );
}
