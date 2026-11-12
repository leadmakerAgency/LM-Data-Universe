// deliver: sends webhooks and automation emails from job_queue.
//
// Woken by pg_net right after a change that queued jobs, and every minute by
// pg_cron (for retries), with the formula worker's shared secret. It claims
// due jobs (jobs_claim builds each payload in the database, reading records
// as the integration's creator may), sends them, and reports each result
// (jobs_done), which schedules retries with growing waits.
//
// Webhooks are POSTed as JSON with:
//   X-LMDU-Timestamp: unix seconds
//   X-LMDU-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the webhook's secret>
//   X-LMDU-Delivery:  the job id (the same on retries)
//
// Secrets (shared with `notify`): SENDGRID_API_KEY, NOTIFY_FROM, APP_URL.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Job =
  | { id: number; kind: "webhook"; url: string; secret: string; body: unknown }
  | { id: number; kind: "email"; to: string[]; subject: string; text: string; doc: string; doc_name: string };

const RUN_FOR_MS = 50_000;
const PARALLEL = 5;
const TIMEOUT_MS = 10_000;

const enc = new TextEncoder();
async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same rule as the database's _safe_url: https, and no local or private hosts.
function safeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password) return false;
    return !/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\..*|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[)/.test(h);
  } catch {
    return false;
  }
}

async function sendWebhook(job: Extract<Job, { kind: "webhook" }>): Promise<{ error: string | null; status: number | null }> {
  if (!safeUrl(job.url)) return { error: "Address not allowed", status: null };
  const body = JSON.stringify(job.body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(job.url, {
      method: "POST",
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LM-Data-Universe-Webhooks/1",
        "X-LMDU-Delivery": String(job.id),
        "X-LMDU-Timestamp": ts,
        "X-LMDU-Signature": `sha256=${await sign(job.secret, `${ts}.${body}`)}`,
      },
      body,
    });
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status >= 200 && res.status < 300) return { error: null, status: res.status };
    return { error: `HTTP ${res.status}${text ? `: ${text}` : ""}`, status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? `No answer within ${TIMEOUT_MS / 1000} s` : e.message) : String(e);
    return { error: msg, status: null };
  } finally {
    clearTimeout(timer);
  }
}

function parseFrom(from: string): { email: string; name?: string } {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() } : { email: from.trim() };
}

async function sendEmail(job: Extract<Job, { kind: "email" }>): Promise<{ error: string | null; status: number | null }> {
  const key = Deno.env.get("SENDGRID_API_KEY");
  const from = Deno.env.get("NOTIFY_FROM");
  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
  if (!key || !from) return { error: "Email isn't set up: the SENDGRID_API_KEY and NOTIFY_FROM secrets are missing", status: null };
  const link = appUrl ? `${appUrl}/doc/${job.doc}` : "";
  const fill = (s: string) => s.replace(/\{\{\s*link\s*\}\}/gi, link);
  const text = `${fill(job.text)}\n\n—\nSent by an automation in “${job.doc_name}”${link ? `: ${link}` : ""}`;
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: job.to.map((email) => ({ email })) }],
        from: parseFrom(from),
        subject: fill(job.subject) || "(no subject)",
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (res.ok) return { error: null, status: res.status };
    return { error: `SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`, status: res.status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: null };
  }
}

async function run(secret: string) {
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  while (Date.now() - started < RUN_FOR_MS) {
    const { data, error } = await db.rpc("jobs_claim", { p_secret: secret, p_limit: 20 });
    if (error) {
      console.error(JSON.stringify({ claim: error.message }));
      return;
    }
    const jobs = (data ?? []) as Job[];
    if (!jobs.length) break;
    for (let i = 0; i < jobs.length; i += PARALLEL) {
      await Promise.all(
        jobs.slice(i, i + PARALLEL).map(async (job) => {
          const r = job.kind === "webhook" ? await sendWebhook(job) : await sendEmail(job);
          if (r.error) failed++;
          else sent++;
          const { error: doneErr } = await db.rpc("jobs_done", { p_secret: secret, p_id: job.id, p_error: r.error, p_status: r.status });
          if (doneErr) console.error(JSON.stringify({ job: job.id, done: doneErr.message }));
        }),
      );
    }
  }
  console.log(JSON.stringify({ sent, failed, ms: Date.now() - started }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = req.headers.get("x-worker-secret") ?? "";
  if (!secret) return new Response("Bad request", { status: 400 });
  // jobs_claim checks the secret. Answer at once and keep working.
  const job = run(secret).catch((e) => console.error(JSON.stringify({ error: String(e) })));
  // @ts-ignore EdgeRuntime is provided by the Supabase runtime.
  EdgeRuntime.waitUntil(job);
  return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
