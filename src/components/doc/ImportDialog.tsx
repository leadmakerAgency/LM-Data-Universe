"use client";

// Import a CSV / TSV / Excel file, a web address or a Google Sheet into a new
// table or an existing one: map columns, optionally update records that match
// on key columns, check the preview, then import.
import clsx from "clsx";
import { FileUp, Globe, Loader2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Select } from "@/components/ui";
import { COLUMN_TYPES, type CellValue, type ColumnType, type DocColumn } from "@/lib/types";
import { addTablesToDoc } from "@/lib/docBuilder";
import { displayValue, parseInput } from "@/lib/format";
import { autoMap, googleSheetsExportUrl, guessColumnType, planImport, readFile, readSheets, type ImportMode, type Sheet } from "@/lib/importer";
import { errorMessage, supabase } from "@/lib/supabase";
import { displayCtx, tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

const CHUNK = 1000;
type Target = string | "new" | null;

const importable = (c: DocColumn) => !c.is_formula && c.type !== "Attachments";

export function ImportDialog({ initialTable, onClose }: { initialTable?: string | null; onClose: () => void }) {
  const tables = useDoc((s) => s.tables);
  const sorted = useMemo(() => [...tables.values()].sort((a, b) => a.position - b.position), [tables]);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [sheetIx, setSheetIx] = useState(0);
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [dest, setDest] = useState<string>(initialTable ?? "new");
  const [tableName, setTableName] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [types, setTypes] = useState<ColumnType[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [mode, setMode] = useState<ImportMode>("add");
  const [keys, setKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const sheet = sheets?.[sheetIx] ?? null;
  const cols = dest === "new" ? [] : tableColumns(dest).filter(importable);

  /** Sets up the mapping for a sheet and destination. */
  const prepare = (s: Sheet, d: string) => {
    setTableName(s.name);
    setTypes(s.header.map((_, i) => guessColumnType(s, i)));
    setLabels([...s.header]);
    if (d === "new") {
      setTargets(s.header.map(() => "new"));
    } else {
      const auto = autoMap(s.header, tableColumns(d).filter(importable));
      setTargets(auto);
      setKeys([]);
      setMode("add");
    }
  };

  const loaded = (list: Sheet[], label: string) => {
    if (!list.length || !list.some((s) => s.rows.length)) throw new Error("No rows found in that file");
    setSheets(list);
    setSheetIx(0);
    setSource(label);
    prepare(list[0], dest);
  };

  const loadFile = async (file: File) => {
    setLoading(true);
    try {
      loaded(await readFile(file), file.name);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const loadUrl = async () => {
    const raw = url.trim();
    if (!/^https?:\/\//i.test(raw)) return toast.error("Enter an address starting with https://");
    setLoading(true);
    try {
      const target = googleSheetsExportUrl(raw) ?? raw;
      const { data } = await supabase().auth.getSession();
      const res = await fetch("/api/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
        body: JSON.stringify({ url: target }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Download failed (${res.status})`);
      const name = decodeURIComponent(res.headers.get("x-file-name") ?? "Imported");
      const isSheets = target !== raw;
      const list = await readSheets(isSheets ? `${name.replace(/\.[^.]+$/, "")}.xlsx` : name, res.headers.get("content-type") ?? "", await res.arrayBuffer());
      loaded(list, isSheets ? "Google Sheets" : new URL(raw).hostname);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // The mapping as columns; columns still to be created get stand-ins.
  const mapping: (DocColumn | null)[] = useMemo(() => {
    if (!sheet) return [];
    return sheet.header.map((_, i) => {
      const t = targets[i];
      if (t === null || t === undefined) return null;
      if (t === "new") {
        return { id: `new:${i}`, doc_id: "", table_ref: dest, col_id: labels[i], label: labels[i] || sheet.header[i], type: types[i] ?? "Text", is_formula: false, formula: "", options: {}, position: 0 };
      }
      return cols.find((c) => c.id === t) ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, targets, types, labels, dest, tables]);

  const plan = useMemo(() => {
    if (!sheet) return null;
    const existing = new Map<number, Record<string, CellValue>>();
    if (dest !== "new") for (const [id, r] of useDoc.getState().rows.get(dest) ?? []) existing.set(id, r.data);
    return planImport(sheet, { mapping, keys, mode: dest === "new" ? "add" : mode }, existing, displayCtx());
  }, [sheet, mapping, keys, mode, dest]);

  const mappedCount = mapping.filter(Boolean).length;
  const needsKeys = dest !== "new" && mode !== "add";
  const canImport = !!sheet && !!plan && mappedCount > 0 && (!needsKeys || keys.length > 0) && (plan.adds.length + plan.updates.length > 0);

  const run = async () => {
    if (!sheet || !plan) return;
    const docId = useDoc.getState().docId!;
    const send = async (actions: unknown[]) => {
      const { error } = await supabase().rpc("apply_actions", { p_doc: docId, p_actions: actions, p_undoable: true, p_source: "app" });
      if (error) throw error;
    };
    try {
      if (dest === "new") {
        setBusy("Creating the table…");
        const used = sheet.header.map((_, i) => i).filter((i) => targets[i] === "new");
        await addTablesToDoc(
          docId,
          [
            {
              name: tableName.trim() || sheet.name,
              columns: used.map((i) => ({ label: labels[i].trim() || sheet.header[i], type: types[i] })),
              rows: sheet.rows.map((r) =>
                used.map((i) => {
                  const col = { type: types[i], options: {} } as DocColumn;
                  const v = parseInput(col, r[i] ?? "");
                  return typeof v === "string" ? v.trim() : v;
                }),
              ),
            },
          ],
          undefined,
          { existingTableIds: sorted.map((t) => t.table_id), startPosition: Math.max(0, ...sorted.map((t) => t.position)) },
        );
        await useDoc.getState().load(docId);
        toast.success(`Imported ${sheet.rows.length} records into a new table`);
        onClose();
        return;
      }
      // Existing table: create the new columns, then plan again with the real ones.
      setBusy("Adding columns…");
      const real: (DocColumn | null)[] = [...mapping];
      for (let i = 0; i < real.length; i++) {
        const m = real[i];
        if (m && m.id.startsWith("new:")) {
          const c = await useDoc.getState().addColumn(dest, { label: m.label, type: m.type });
          if (!c) throw new Error(`Couldn't add the column ${m.label}`);
          real[i] = c;
        }
      }
      const existing = new Map<number, Record<string, CellValue>>();
      for (const [id, r] of useDoc.getState().rows.get(dest) ?? []) existing.set(id, r.data);
      const final = planImport(sheet, { mapping: real, keys, mode }, existing, displayCtx());
      for (let i = 0; i < final.updates.length; i += CHUNK) {
        setBusy(`Updating records ${i + 1}–${Math.min(i + CHUNK, final.updates.length)} of ${final.updates.length}…`);
        await send([{ op: "UpdateRecords", table: dest, records: final.updates.slice(i, i + CHUNK) }]);
      }
      for (let i = 0; i < final.adds.length; i += CHUNK) {
        setBusy(`Adding records ${i + 1}–${Math.min(i + CHUNK, final.adds.length)} of ${final.adds.length}…`);
        await send([{ op: "AddRecords", table: dest, records: final.adds.slice(i, i + CHUNK).map((data) => ({ data })) }]);
      }
      await useDoc.getState().load(docId);
      toast.success(
        [final.adds.length && `${final.adds.length} added`, final.updates.length && `${final.updates.length} updated`, final.unchanged && `${final.unchanged} unchanged`]
          .filter(Boolean)
          .join(", ") || "Nothing to import",
      );
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Preview: the first rows as they'll be stored.
  const ctx = displayCtx();
  const previewCols = mapping.map((c, i) => ({ c, i })).filter((x): x is { c: DocColumn; i: number } => !!x.c);

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Import data"
      width={900}
      footer={
        <>
          {busy && (
            <span className="mr-auto flex items-center gap-2 text-sm text-gray-600">
              <Loader2 size={14} className="animate-spin" /> {busy}
            </span>
          )}
          <Button onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={!canImport || !!busy}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-sm">
        <section>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">1. Data</div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => fileInput.current?.click()} disabled={loading}>
              <FileUp size={14} /> Choose a file
            </Button>
            <span className="text-xs text-gray-400">CSV, TSV or Excel, up to 20 MB · or</span>
            <div className="flex min-w-72 flex-1 gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (a CSV or Excel file, or a Google Sheets link)" onKeyDown={(e) => e.key === "Enter" && void loadUrl()} />
              <Button onClick={loadUrl} disabled={loading || !url.trim()}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />} Load
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept=".csv,.tsv,.txt,.xlsx,.xlsm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void loadFile(f);
              }}
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">Google Sheets must be shared so anyone with the link can view.</p>
          {sheets && sheet && (
            <div className="mt-2 flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-700">
              <span className="font-medium">{source}</span>
              {sheets.length > 1 ? (
                <Select
                  className="h-7 !w-auto text-xs"
                  value={sheetIx}
                  onChange={(e) => {
                    const ix = Number(e.target.value);
                    setSheetIx(ix);
                    prepare(sheets[ix], dest);
                  }}
                >
                  {sheets.map((s, i) => (
                    <option key={i} value={i}>
                      {s.name} ({s.rows.length} rows)
                    </option>
                  ))}
                </Select>
              ) : null}
              <span>
                · {sheet.rows.length} rows · {sheet.header.length} columns
              </span>
            </div>
          )}
        </section>

        {sheet && (
          <section>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">2. Into</div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                className="!w-60"
                value={dest}
                onChange={(e) => {
                  setDest(e.target.value);
                  prepare(sheet, e.target.value);
                }}
              >
                <option value="new">A new table</option>
                {sorted.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.table_id}
                  </option>
                ))}
              </Select>
              {dest === "new" && <Input className="!w-60" value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="Table name" />}
            </div>
          </section>
        )}

        {sheet && (
          <section>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">3. Columns</div>
            <div className="scroll-thin max-h-64 overflow-y-auto rounded-md border border-gray-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">From the file</th>
                    <th className="px-3 py-1.5 font-medium">Example</th>
                    <th className="px-3 py-1.5 font-medium">{dest === "new" ? "Column" : "Goes into"}</th>
                    <th className="px-3 py-1.5 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sheet.header.map((h, i) => {
                    const t = targets[i];
                    const example = sheet.rows.find((r) => (r[i] ?? "").trim())?.[i] ?? "";
                    return (
                      <tr key={i} className={clsx(t === null && "text-gray-400")}>
                        <td className="px-3 py-1.5 font-medium">{h}</td>
                        <td className="max-w-40 truncate px-3 py-1.5 text-gray-500" title={example}>
                          {example}
                        </td>
                        <td className="px-3 py-1">
                          {dest === "new" ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={t === "new"}
                                onChange={(e) => setTargets(targets.map((x, k) => (k === i ? (e.target.checked ? "new" : null) : x)))}
                                title="Import this column"
                              />
                              <Input className="h-7 text-xs" value={labels[i] ?? ""} disabled={t !== "new"} onChange={(e) => setLabels(labels.map((x, k) => (k === i ? e.target.value : x)))} />
                            </div>
                          ) : (
                            <Select
                              className="h-7 text-xs"
                              value={t ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                setTargets(targets.map((x, k) => (k === i ? (v === "" ? null : v) : x)));
                                setKeys(keys.filter((k) => k !== t));
                              }}
                            >
                              <option value="">Don&apos;t import</option>
                              {cols.map((c) => (
                                <option key={c.id} value={c.id} disabled={targets.includes(c.id) && t !== c.id}>
                                  {c.label || c.col_id}
                                </option>
                              ))}
                              <option value="new">+ New column “{h}”</option>
                            </Select>
                          )}
                        </td>
                        <td className="px-3 py-1">
                          {t === "new" ? (
                            <Select className="h-7 text-xs" value={types[i]} onChange={(e) => setTypes(types.map((x, k) => (k === i ? (e.target.value as ColumnType) : x)))}>
                              {COLUMN_TYPES.filter((x) => !["Ref", "RefList", "Attachments"].includes(x.type)).map((x) => (
                                <option key={x.type} value={x.type}>
                                  {x.label}
                                </option>
                              ))}
                            </Select>
                          ) : t ? (
                            <span className="text-gray-500">{COLUMN_TYPES.find((x) => x.type === cols.find((c) => c.id === t)?.type)?.label}</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {sheet && dest !== "new" && (
          <section>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">4. Existing records</div>
            <div className="space-y-1">
              {(
                [
                  ["add", "Add every row as a new record"],
                  ["upsert", "Update records that match on the key columns; add the rest"],
                  ["update", "Only update records that match; add nothing"],
                ] as const
              ).map(([m, label]) => (
                <label key={m} className="flex items-center gap-2">
                  <input type="radio" checked={mode === m} onChange={() => setMode(m)} /> {label}
                </label>
              ))}
            </div>
            {mode !== "add" && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-gray-500">Key columns:</span>
                {mapping
                  .filter((c): c is DocColumn => !!c && !c.id.startsWith("new:"))
                  .map((c) => (
                    <label
                      key={c.id}
                      className={clsx(
                        "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                        keys.includes(c.id) ? "border-brand-300 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600",
                      )}
                    >
                      <input type="checkbox" className="sr-only" checked={keys.includes(c.id)} onChange={(e) => setKeys(e.target.checked ? [...keys, c.id] : keys.filter((k) => k !== c.id))} />
                      {c.label || c.col_id}
                    </label>
                  ))}
                {keys.length === 0 && <span className="text-xs text-amber-700">Pick at least one, e.g. an email or an id column.</span>}
              </div>
            )}
          </section>
        )}

        {sheet && plan && (
          <section>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Preview</div>
            <p className="mb-2 text-sm">
              <b>{plan.adds.length}</b> new {plan.adds.length === 1 ? "record" : "records"}
              {dest !== "new" && mode !== "add" && (
                <>
                  {" "}
                  · <b>{plan.updates.length}</b> updated · {plan.unchanged} unchanged
                  {plan.skipped > 0 && <> · {plan.skipped} skipped ({mode === "update" ? "no match or no key" : "no key value"})</>}
                  {plan.ambiguous > 0 && <span className="text-amber-700"> · {plan.ambiguous} match several records (the first is updated)</span>}
                </>
              )}
            </p>
            {previewCols.length > 0 && (
              <div className="scroll-thin overflow-x-auto rounded-md border border-gray-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      {previewCols.map(({ c }) => (
                        <th key={c.id} className="whitespace-nowrap px-3 py-1.5 font-medium">
                          {c.label || c.col_id}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {sheet.rows.slice(0, 5).map((r, k) => (
                      <tr key={k}>
                        {previewCols.map(({ c, i }) => {
                          const v = parseInput(c, r[i] ?? "", ctx);
                          const bad = typeof v === "string" && v.trim() !== "" && !["Text", "Any", "Choice"].includes(c.type);
                          return (
                            <td key={c.id} className={clsx("max-w-48 truncate whitespace-nowrap px-3 py-1", bad && "text-red-600")} title={bad ? "Doesn't fit the column type; kept as text" : undefined}>
                              {c.id.startsWith("new:") ? String(v ?? "") : displayValue(ctx, c, v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
