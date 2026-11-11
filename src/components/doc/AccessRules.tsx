"use client";

// Access rules page: who may read, add, change and delete which records and
// columns. Rules are edited here as a draft and saved together; the database
// checks and enforces them (see the phase3_access_rules migration).
import clsx from "clsx";
import { AlertTriangle, ArrowDown, ArrowUp, Eye, Lock, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AclConditionError, compileCondition, conditionCompletions, printCondition, type AclSchema } from "@engine/acl";
import { Button, IconButton, Input, Label, Select, Spinner } from "@/components/ui";
import { errorMessage, supabase } from "@/lib/supabase";
import { tableColumns, useDoc } from "@/store/docStore";
import { useComments } from "@/store/comments";
import { toast } from "@/store/toasts";
import type { AccessRule, AccessSettings, AclPermission, DocColumn, UserAttribute } from "@/lib/types";

interface DraftRule {
  key: string;
  table_ref: string | null;
  /** A rule about some columns' cells (otherwise about whole records). */
  column: boolean;
  col_ids: string[];
  condition: string;
  permissions: Partial<Record<AclPermission, boolean>>;
  memo: string;
  /** The saved condition no longer compiles on the server (it fails closed). */
  broken?: boolean;
}

interface Loaded {
  can_edit: boolean;
  /** False until an owner saves the special rules (defaults then depend on whether there are rules). */
  settings_saved?: boolean;
  rules: AccessRule[];
  attributes: UserAttribute[];
  settings: AccessSettings;
}

const RECORD_PERMS: AclPermission[] = ["read", "create", "update", "delete"];
const COLUMN_PERMS: AclPermission[] = ["read", "update"];
const PERM_LABEL: Record<AclPermission, string> = { read: "Read", create: "Add", update: "Change", delete: "Delete" };
const DEFAULT_SETTINGS: AccessSettings = { editors_structure: true, block_copies: false, public_rules: false };

let keySeq = 0;
const nextKey = () => `r${++keySeq}`;

export function AccessRulesView() {
  const docId = useDoc((s) => s.docId);
  const tables = useDoc((s) => s.tables);
  const columns = useDoc((s) => s.columns);
  const role = useDoc((s) => s.role);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [attrs, setAttrs] = useState<(UserAttribute & { key: string })[]>([]);
  const [settings, setSettings] = useState<AccessSettings>(DEFAULT_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const tableList = useMemo(() => [...tables.values()].sort((a, b) => a.position - b.position), [tables]);
  const schema: AclSchema = useMemo(
    () => ({ tables: tableList, columns: [...columns.values()], attributes: attrs.map((a) => ({ name: a.name, table_ref: a.table_ref })) }),
    [tableList, columns, attrs],
  );

  const reset = (data: Loaded) => {
    const sch: AclSchema = { tables: tableList, columns: [...columns.values()], attributes: data.attributes };
    setLoaded(data);
    setAttrs(data.attributes.map((a) => ({ ...a, key: nextKey() })));
    // Never saved: start from the safe choice for a document with rules.
    setSettings({ ...DEFAULT_SETTINGS, ...data.settings, ...(data.settings_saved ? {} : { editors_structure: false }) });
    setRules(
      data.rules.map((r) => {
        // Show the condition with today's names; keep the saved text if a name is gone.
        const printed = printCondition(r.condition_ast, sch);
        const missing = /(^|\.)\?(\.|$|\W)/.test(printed);
        return {
          key: nextKey(),
          table_ref: r.table_ref,
          column: (r.col_ids ?? []).length > 0,
          col_ids: r.col_ids ?? [],
          condition: missing || (!r.condition_ast && r.condition) ? r.condition : printed,
          permissions: r.permissions ?? {},
          memo: r.memo ?? "",
          broken: r.valid === false || missing,
        };
      }),
    );
    setDirty(false);
    setSaveError(null);
  };

  useEffect(() => {
    if (!docId) return;
    let live = true;
    void supabase()
      .rpc("get_access_rules", { p_doc: docId })
      .then(({ data, error }) => {
        if (!live) return;
        if (error) setLoadError(errorMessage(error));
        else reset(data as Loaded);
      });
    return () => {
      live = false;
    };
    // Load once per document; later schema changes are picked up when printing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const canEdit = !!loaded?.can_edit && role === "owner";

  // Condition errors, checked as you type.
  const errors = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of rules) {
      try {
        compileCondition(r.condition, schema, r.table_ref);
      } catch (e) {
        out.set(r.key, e instanceof AclConditionError ? e.message : String(e));
      }
      if (!Object.keys(r.permissions).length) out.set(`${r.key}:perm`, "Choose at least one permission to allow or deny");
      if (r.column && r.col_ids.length === 0) out.set(`${r.key}:cols`, "Pick the columns this rule is about");
    }
    return out;
  }, [rules, schema]);

  const change = (fn: (rs: DraftRule[]) => DraftRule[]) => {
    setRules(fn);
    setDirty(true);
  };
  const update = (key: string, patch: Partial<DraftRule>) => change((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, broken: false } : r)));
  const remove = (key: string) => change((rs) => rs.filter((r) => r.key !== key));
  /** Moves a rule up or down among the rules of its own group. */
  const move = (key: string, delta: number) =>
    change((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const group = (r: DraftRule) => `${r.table_ref}|${r.column}`;
      let j = i + delta;
      while (j >= 0 && j < rs.length && group(rs[j]) !== group(rs[i])) j += delta;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const add = (table_ref: string | null, columnRule: boolean) =>
    change((rs) => [...rs, { key: nextKey(), table_ref, column: columnRule, col_ids: [], condition: "", permissions: {}, memo: "" }]);

  const isColumnRule = (r: DraftRule) => r.column;

  const save = async () => {
    if (!docId || saving) return;
    if (errors.size) {
      setSaveError("Fix the highlighted rules first.");
      return;
    }
    const ordered = [
      ...tableList.flatMap((t) => [
        ...rules.filter((r) => r.table_ref === t.id && !isColumnRule(r)),
        ...rules.filter((r) => r.table_ref === t.id && isColumnRule(r)),
      ]),
      ...rules.filter((r) => r.table_ref === null),
    ];
    const payload = ordered.map((r) => ({
      table_ref: r.table_ref,
      col_ids: isColumnRule(r) ? r.col_ids : [],
      condition: r.condition.trim(),
      condition_ast: compileCondition(r.condition, schema, r.table_ref),
      permissions: r.permissions,
      memo: r.memo.trim() || null,
    }));
    setSaving(true);
    setSaveError(null);
    const { data, error } = await supabase().rpc("save_access_rules", {
      p_doc: docId,
      p_rules: payload,
      p_attributes: attrs.map(({ name, user_field, table_ref, match_col }) => ({ name, user_field, table_ref, match_col })),
      p_settings: settings,
    });
    setSaving(false);
    if (error) {
      setSaveError(errorMessage(error));
      return;
    }
    reset(data as Loaded);
    toast.success("Access rules saved");
    // The document is re-read with the new rules applied.
    void useDoc.getState().load(docId);
  };

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
        <Lock size={16} className="mb-2 text-gray-400" />
        {loadError}
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }

  const ruleRows = (list: DraftRule[], tableRef: string | null) =>
    list.map((r, i) => (
      <RuleRow
        key={r.key}
        rule={r}
        tableRef={tableRef}
        columnRule={isColumnRule(r)}
        columns={tableRef ? tableColumns(tableRef) : []}
        schema={schema}
        error={errors.get(r.key) ?? errors.get(`${r.key}:perm`) ?? errors.get(`${r.key}:cols`)}
        canEdit={canEdit}
        first={i === 0}
        last={i === list.length - 1}
        onChange={(patch) => update(r.key, patch)}
        onRemove={() => remove(r.key)}
        onMove={(d) => move(r.key, d)}
      />
    ));

  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-16">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Access rules</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">
            Rules narrow what each person&apos;s role allows; they never give more. For each table, its rules are tried top to bottom,
            then the default rules; the first rule whose condition is true decides. Column rules hide or lock cells on top of that.
            Conditions use <code className="rounded bg-gray-100 px-1">user.Email</code>, <code className="rounded bg-gray-100 px-1">user.Access</code>{" "}
            (owner, editor, viewer), <code className="rounded bg-gray-100 px-1">rec.Column</code> and <code className="rounded bg-gray-100 px-1">newRec.Column</code>.
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" disabled={!dirty || saving} onClick={() => reset(loaded)}>
              Revert
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save rules"}
            </Button>
          </div>
        )}
      </div>
      {!canEdit && (
        <p className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600">Only owners can change these rules.</p>
      )}
      {saveError && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{saveError}</p>}

      {canEdit && <ViewAsBox />}

      {tableList.map((t) => {
        const own = rules.filter((r) => r.table_ref === t.id);
        const recordRules = own.filter((r) => !isColumnRule(r));
        const columnRules = own.filter((r) => isColumnRule(r));
        return (
          <section key={t.id} className="rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={t.table_id}>
                {t.table_id}
              </h2>
              {canEdit && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => add(t.id, false)}>
                    <Plus size={13} /> Record rule
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => add(t.id, true)}>
                    <Plus size={13} /> Column rule
                  </Button>
                </>
              )}
            </div>
            {own.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-400">No rules: the default rules apply.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {columnRules.length > 0 && <GroupLabel>Columns</GroupLabel>}
                {ruleRows(columnRules, t.id)}
                {recordRules.length > 0 && <GroupLabel>Records</GroupLabel>}
                {ruleRows(recordRules, t.id)}
              </div>
            )}
          </section>
        );
      })}

      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
          <h2 className="flex-1 text-sm font-semibold">Default rules (every table)</h2>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => add(null, false)}>
              <Plus size={13} /> Default rule
            </Button>
          )}
        </div>
        {rules.some((r) => r.table_ref === null) ? (
          <div className="divide-y divide-gray-100">{ruleRows(rules.filter((r) => r.table_ref === null), null)}</div>
        ) : (
          <p className="px-4 py-3 text-sm text-gray-400">No default rules: everyone can do what their role allows.</p>
        )}
      </section>

      <AttributesEditor
        attrs={attrs}
        canEdit={canEdit}
        onChange={(next) => {
          setAttrs(next);
          setDirty(true);
        }}
      />

      <section className="rounded-lg border border-gray-200 bg-white px-4 py-3">
        <h2 className="mb-2 text-sm font-semibold">Special rules</h2>
        {(
          [
            [
              "editors_structure",
              "Editors may add, change and remove tables and columns",
              "Owners always can. Leave this off when rules hide data: whoever can change columns can write a formula that shows any value, or remove a column with cells they can't see.",
            ],
            ["block_copies", "Only owners may copy the document or download its data", "Hides Save a copy, Work on a copy and the export menus for others."],
            ["public_rules", "Everyone with access may see these rules", "Otherwise only owners can open this page."],
          ] as [keyof AccessSettings, string, string][]
        ).map(([k, label, help]) => (
          <label key={k} className="flex items-start gap-2 py-1 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={!canEdit}
              checked={settings[k]}
              onChange={(e) => {
                setSettings({ ...settings, [k]: e.target.checked });
                setDirty(true);
              }}
            />
            <span>
              {label}
              <span className="block text-xs text-gray-500">{help}</span>
            </span>
          </label>
        ))}
      </section>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="bg-gray-50 px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{children}</div>;
}

function RuleRow(props: {
  rule: DraftRule;
  tableRef: string | null;
  columnRule: boolean;
  columns: DocColumn[];
  schema: AclSchema;
  error?: string;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<DraftRule>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const { rule, tableRef, columnRule, columns, schema, error, canEdit, onChange } = props;
  const perms = columnRule ? COLUMN_PERMS : RECORD_PERMS;
  const cycle = (p: AclPermission) => {
    const next = { ...rule.permissions };
    if (next[p] === undefined) next[p] = true;
    else if (next[p] === true) next[p] = false;
    else delete next[p];
    onChange({ permissions: next });
  };
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-start gap-3">
        {columnRule && (
          <div className="w-56 shrink-0">
            <div className="flex flex-wrap gap-1">
              {rule.col_ids.map((id) => {
                const c = columns.find((x) => x.id === id);
                return (
                  <span key={id} className="inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
                    {c ? c.label || c.col_id : "(removed)"}
                    {canEdit && (
                      <button onClick={() => onChange({ col_ids: rule.col_ids.filter((x) => x !== id) })} aria-label="Remove column">
                        <X size={11} />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {canEdit && (
              <Select
                className="mt-1 h-7 text-xs"
                value=""
                onChange={(e) => e.target.value && onChange({ col_ids: [...rule.col_ids, e.target.value] })}
              >
                <option value="">Add column…</option>
                {columns
                  .filter((c) => !rule.col_ids.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label || c.col_id}
                    </option>
                  ))}
              </Select>
            )}
          </div>
        )}
        <div className="min-w-64 flex-1">
          <ConditionInput value={rule.condition} disabled={!canEdit} schema={schema} tableRef={tableRef} onChange={(condition) => onChange({ condition })} />
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          {rule.broken && (
            <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle size={12} /> This rule refers to something that no longer exists. Until it is fixed, a deny always applies and an
              allow never does.
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {perms.map((p) => {
            const v = rule.permissions[p];
            return (
              <button
                key={p}
                disabled={!canEdit}
                onClick={() => cycle(p)}
                title={`${PERM_LABEL[p]}: ${v === true ? "allow" : v === false ? "deny" : "not decided here"} (click to change)`}
                className={clsx(
                  "h-7 min-w-14 rounded-md border px-2 text-xs font-medium",
                  v === true && "border-emerald-300 bg-emerald-50 text-emerald-700",
                  v === false && "border-red-300 bg-red-50 text-red-700 line-through",
                  v === undefined && "border-gray-200 bg-white text-gray-400",
                )}
              >
                {PERM_LABEL[p]}
              </button>
            );
          })}
        </div>
        {canEdit && (
          <div className="flex shrink-0">
            <IconButton title="Move up" disabled={props.first} onClick={() => props.onMove(-1)}>
              <ArrowUp size={14} />
            </IconButton>
            <IconButton title="Move down" disabled={props.last} onClick={() => props.onMove(1)}>
              <ArrowDown size={14} />
            </IconButton>
            <IconButton title="Remove rule" onClick={props.onRemove}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        )}
      </div>
      {(canEdit || rule.memo) && (
        <input
          value={rule.memo}
          disabled={!canEdit}
          onChange={(e) => onChange({ memo: e.target.value })}
          placeholder="Note (optional)"
          className="mt-1 w-full bg-transparent text-xs text-gray-500 outline-none placeholder:text-gray-300"
        />
      )}
    </div>
  );
}

/** Condition text box with completion of user., rec. and column names. */
function ConditionInput(props: { value: string; disabled: boolean; schema: AclSchema; tableRef: string | null; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const completion = useMemo(
    () => (focused ? conditionCompletions(props.value.slice(0, cursor), props.schema, props.tableRef) : { prefix: "", items: [] }),
    [focused, props.value, cursor, props.schema, props.tableRef],
  );
  const items = completion.items.slice(0, 8);
  const accept = (item: string) => {
    const before = props.value.slice(0, cursor - completion.prefix.length) + item;
    const next = before + props.value.slice(cursor);
    props.onChange(next);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(before.length, before.length);
      setCursor(before.length);
    });
  };
  return (
    <div className="relative">
      <input
        ref={ref}
        value={props.value}
        disabled={props.disabled}
        placeholder="Everyone (always)"
        spellCheck={false}
        className="h-8 w-full rounded-md border border-gray-300 bg-white px-3 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50"
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onChange={(e) => {
          props.onChange(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
        }}
        onSelect={(e) => setCursor((e.target as HTMLInputElement).selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (!items.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
          } else if (e.key === "Tab" || e.key === "Enter") {
            e.preventDefault();
            accept(items[Math.min(active, items.length - 1)]);
          } else if (e.key === "Escape") {
            setFocused(false);
          }
        }}
      />
      {items.length > 0 && !props.disabled && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          {items.map((item, i) => (
            <button
              key={item}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(item);
              }}
              className={clsx("block w-full px-3 py-1 text-left font-mono text-xs", i === active ? "bg-brand-50 text-brand-700" : "hover:bg-gray-50")}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AttributesEditor(props: { attrs: (UserAttribute & { key: string })[]; canEdit: boolean; onChange: (a: (UserAttribute & { key: string })[]) => void }) {
  const tables = useDoc((s) => s.tables);
  const tableList = [...tables.values()].sort((a, b) => a.position - b.position);
  const { attrs, canEdit, onChange } = props;
  const set = (key: string, patch: Partial<UserAttribute>) => onChange(attrs.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">User attributes</h2>
          <p className="text-xs text-gray-500">
            Look up the signed-in person in a table, e.g. <code>user.Person.Department</code> from a People table matched by email.
          </p>
        </div>
        {canEdit && tableList.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const t = tableList[0];
              onChange([...attrs, { key: nextKey(), name: `Attr${attrs.length + 1}`, user_field: "Email", table_ref: t.id, match_col: tableColumns(t.id)[0]?.id ?? "" }]);
            }}
          >
            <Plus size={13} /> Attribute
          </Button>
        )}
      </div>
      {attrs.length === 0 ? (
        <p className="px-4 py-3 text-sm text-gray-400">None.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {attrs.map((a) => (
            <div key={a.key} className="flex flex-wrap items-end gap-3 px-4 py-2.5">
              <div className="w-40">
                <Label>Name</Label>
                <Input className="h-8 font-mono text-xs" disabled={!canEdit} value={a.name} onChange={(e) => set(a.key, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} />
              </div>
              <div className="w-44">
                <Label>Table</Label>
                <Select
                  className="h-8 text-xs"
                  disabled={!canEdit}
                  value={a.table_ref}
                  onChange={(e) => set(a.key, { table_ref: e.target.value, match_col: tableColumns(e.target.value)[0]?.id ?? "" })}
                >
                  {tableList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.table_id}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-44">
                <Label>Where column</Label>
                <Select className="h-8 text-xs" disabled={!canEdit} value={a.match_col} onChange={(e) => set(a.key, { match_col: e.target.value })}>
                  {tableColumns(a.table_ref).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label || c.col_id}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-36">
                <Label>Equals user.</Label>
                <Select className="h-8 text-xs" disabled={!canEdit} value={a.user_field} onChange={(e) => set(a.key, { user_field: e.target.value as UserAttribute["user_field"] })}>
                  <option value="Email">Email</option>
                  <option value="UserID">UserID</option>
                  <option value="Name">Name</option>
                </Select>
              </div>
              {canEdit && (
                <IconButton title="Remove attribute" onClick={() => onChange(attrs.filter((x) => x.key !== a.key))}>
                  <Trash2 size={14} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Owners: open the document as someone else sees it. */
function ViewAsBox() {
  const people = useComments((s) => s.people);
  const me = useDoc((s) => s.me);
  const [email, setEmail] = useState("");
  const others = [...people.values()].filter((p) => p.id !== me?.UserID);
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
      <Eye size={15} className="text-gray-400" />
      <span className="text-sm font-medium">View as</span>
      <Input
        className="h-8 w-64 text-sm"
        list="acl-view-as-people"
        placeholder="someone@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && email.trim() && void useDoc.getState().setViewAs(email)}
      />
      <datalist id="acl-view-as-people">
        {others.map((p) => (
          <option key={p.id} value={p.email}>
            {p.full_name ?? ""}
          </option>
        ))}
      </datalist>
      <Button size="sm" disabled={!email.trim()} onClick={() => void useDoc.getState().setViewAs(email)}>
        Open their view
      </Button>
      <span className="text-xs text-gray-500">Shows the saved rules, read-only. Save first to check a change.</span>
    </section>
  );
}
