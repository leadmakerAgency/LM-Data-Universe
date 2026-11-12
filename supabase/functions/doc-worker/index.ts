// doc-worker: recomputes formula values on the server.
//
// Called by pg_net (see the *_formula_worker.sql migration) with
// {doc_id} and the shared secret. Answers 202 at once and keeps working in
// the background: load the document, find the formula columns affected by
// the actions logged since the last run, recompute them and write the
// changed values to doc_rows.computed. Loops while new actions keep arriving.
//
// engine.js is packages/engine bundled by `npm run build:worker`.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { changeSetFromActions, recompute, triggerUpdatesForApplied } from "./engine.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PAGE = 1000;
const WRITE_CHUNK = 500;
const MAX_ROUNDS = 20;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function selectAll(table: string, columns: string, filter: (q: Row) => Row): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(db.from(table).select(columns)).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function rpc<T>(fn: string, args: Row): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function runOnce(docId: string, secret: string, claim: { done_id: number; requested_id: number }) {
  const started = Date.now();
  const [docRes, tables, columns, rows, actions] = await Promise.all([
    db.from("documents").select("settings").eq("id", docId).maybeSingle(),
    selectAll("doc_tables", "*", (q) => q.eq("doc_id", docId)),
    selectAll("doc_columns", "*", (q) => q.eq("doc_id", docId)),
    selectAll("doc_rows", "id,table_ref,manual_sort,data,computed", (q) => q.eq("doc_id", docId)),
    claim.done_id > 0
      ? selectAll("doc_actions", "id,actions,source", (q) => q.eq("doc_id", docId).gt("id", claim.done_id).lte("id", claim.requested_id))
      : Promise.resolve([]),
  ]);

  const change =
    claim.done_id > 0
      ? changeSetFromActions(actions.map((a) => a.actions))
      : { cols: new Set<string>(), tables: new Set<string>(), all: true }; // first run: everything

  const colsByTable = new Map<string, Row[]>();
  for (const t of tables) colsByTable.set(t.id, []);
  for (const c of columns) colsByTable.get(c.table_ref)?.push(c);
  for (const list of colsByTable.values()) list.sort((a, b) => a.position - b.position);
  const rowMap = new Map<string, Map<number, Row>>();
  for (const t of tables) rowMap.set(t.id, new Map());
  const current = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    rowMap.get(r.table_ref)?.set(r.id, { id: r.id, table_ref: r.table_ref, manual_sort: r.manual_sort, data: r.data ?? {} });
    current.set(r.id, r.computed ?? {});
  }

  // TODAY() uses the document's time zone (Document settings); UTC if none is set.
  const timezone = typeof docRes.data?.settings?.timezone === "string" ? docRes.data.settings.timezone : "UTC";
  const data = {
    tables: new Map(tables.map((t) => [t.id, t])),
    columns: new Map(columns.map((c) => [c.id, c])),
    colsByTable,
    rows: rowMap,
    timezone,
  };

  // Trigger formulas for records added or changed outside the app (forms, API).
  // The app computes its own; 'system' bundles are our own output.
  const outside = actions.filter((a) => a.source !== "app" && a.source !== "system").map((a) => a.actions);
  if (outside.length) {
    const fills = triggerUpdatesForApplied(data, outside, null);
    if (fills.length) {
      // Logged as a new action, which queues another round that recomputes formulas with these values.
      await rpc("worker_apply_triggers", { p_doc: docId, p_secret: secret, p_actions: fills });
    }
  }

  const { updates, recomputed } = recompute(data, current, change);

  let written = 0;
  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    written += await rpc<number>("worker_set_computed", {
      p_doc: docId,
      p_secret: secret,
      p_updates: updates.slice(i, i + WRITE_CHUNK),
    });
  }
  console.log(
    JSON.stringify({
      doc: docId,
      actions: `${claim.done_id + 1}..${claim.requested_id}`,
      full: change.all,
      rows: rows.length,
      formulas: recomputed.length,
      written,
      ms: Date.now() - started,
    }),
  );
}

async function run(docId: string, secret: string) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const claim = await rpc<{ done_id: number; requested_id: number }>("worker_start", { p_doc: docId, p_secret: secret });
    try {
      await runOnce(docId, secret, claim);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ doc: docId, error: message }));
      await rpc("worker_finish", { p_doc: docId, p_secret: secret, p_done_id: claim.done_id, p_error: message.slice(0, 2000) });
      return;
    }
    const again = await rpc<boolean>("worker_finish", { p_doc: docId, p_secret: secret, p_done_id: claim.requested_id });
    if (!again) return;
  }
  // Still busy after many rounds: release the claim; the next action restarts it.
  await rpc("worker_finish", { p_doc: docId, p_secret: secret, p_done_id: 0, p_error: "Gave up after too many rounds" });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = req.headers.get("x-worker-secret") ?? "";
  let docId = "";
  try {
    docId = String((await req.json())?.doc_id ?? "");
  } catch {
    // fall through
  }
  if (!UUID.test(docId) || !secret) return new Response("Bad request", { status: 400 });
  // worker_start checks the secret; failures end up in the function logs.
  const job = run(docId, secret).catch((e) => console.error(JSON.stringify({ doc: docId, error: String(e) })));
  // @ts-ignore EdgeRuntime is provided by the Supabase runtime.
  EdgeRuntime.waitUntil(job);
  return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
