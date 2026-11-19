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
// Emails are written as Markdown and sent as text + HTML; the secrets are
// described in ../_shared/mail.ts. Errors that can't get better (a refused
// request, a wrong key, an unverified sender) are not retried.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { mailConfig, reportMail, sendMail, type MailConfig, type SendResult } from "../_shared/mail.ts";
import { escapeHtml, plainText, renderHtml } from "../_shared/markdown.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface EmailJob {
  id: number;
  kind: "email";
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string | null;
  from_name?: string | null;
  subject: string;
  /** Markdown; values from the record are already escaped. */
  text: string;
  doc: string;
  doc_name: string;
  row?: number | null;
  table_ref?: string | null;
  automation?: string | null;
  test?: boolean;
}
type Job = { id: number; kind: "webhook"; url: string; secret: string; body: unknown } | EmailJob;

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

async function sendWebhook(job: Extract<Job, { kind: "webhook" }>): Promise<{ error: string | null; status: number | null; retry?: boolean }> {
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

function emailBody(job: EmailJob, cfg: MailConfig): { subject: string; text: string; html: string } {
  const link = cfg.appUrl ? `${cfg.appUrl}/doc/${job.doc}` : "";
  const recordLink = link && job.table_ref && job.row ? `${link}?record=${job.table_ref}:${job.row}` : link;
  const fill = (s: string) => s.replace(/\{\{\s*record_link\s*\}\}/gi, recordLink).replace(/\{\{\s*link\s*\}\}/gi, link);
  const body = fill(job.text);
  const note = `Sent by the automation “${job.automation || "Automation"}” in “${job.doc_name}”${job.test ? " (test)" : ""}`;
  const text = `${plainText(body)}\n\n—\n${note}${link ? `: ${link}` : ""}`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#1f2330;max-width:600px">
${renderHtml(body)}
<p style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">${escapeHtml(note)}${link ? ` · <a href="${escapeHtml(link)}" style="color:#5a43d9">Open the document</a>` : ""}</p>
</div>`;
  return { subject: fill(job.subject), text, html };
}

async function sendEmail(job: EmailJob, cfg: MailConfig): Promise<SendResult> {
  const m = emailBody(job, cfg);
  return sendMail(cfg, {
    to: job.to,
    cc: job.cc,
    bcc: job.bcc,
    replyTo: job.reply_to,
    fromName: job.from_name,
    subject: m.subject,
    text: m.text,
    html: m.html,
    category: "automation",
    args: { lmdu_job: String(job.id), lmdu_doc: job.doc },
  });
}

async function run(secret: string) {
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  const cfg = mailConfig();
  // What the emails of this run say about the account: null = no email tried.
  let mailOk: boolean | null = null;
  let mailError: string | null = null;
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
          let r: { error: string | null; status: number | null; retry?: boolean };
          if (job.kind === "webhook") r = await sendWebhook(job);
          else {
            const m = await sendEmail(job, cfg);
            r = m;
            if (m.setup) {
              mailOk = false;
              mailError = m.error;
            } else if (!m.error && mailOk === null) mailOk = true;
          }
          if (r.error) failed++;
          else sent++;
          const { error: doneErr } = await db.rpc("jobs_done", { p_secret: secret, p_id: job.id, p_error: r.error, p_status: r.status, p_retry: r.retry ?? true });
          if (doneErr) console.error(JSON.stringify({ job: job.id, done: doneErr.message }));
        }),
      );
    }
  }
  if (mailOk !== null) await reportMail(db, secret, cfg, mailOk, mailError);
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
