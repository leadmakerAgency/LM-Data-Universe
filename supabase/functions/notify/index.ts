// notify: sends queued emails (invites, "shared with you", @mentions) through
// SendGrid. Called every minute by pg_cron (see *_notify_delivery.sql) with
// the formula worker's shared secret.
//
// The secrets are described in ../_shared/mail.ts. Also sends the test email
// administrators ask for, and reports whether email is set up.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { mailConfig, reportMail, sendMail } from "../_shared/mail.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Queued {
  id: number;
  kind: "invite" | "shared" | "mention" | "test";
  to_email: string;
  payload: Record<string, string>;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function render(q: Queued, appUrl: string): { subject: string; text: string; html: string } {
  const p = q.payload;
  const roleWord = p.role === "owner" ? "an owner" : p.role === "editor" ? "an editor" : "a viewer";
  const what = p.target === "team" ? `the team “${p.name}”` : p.target === "workspace" ? `the workspace “${p.name}”` : `“${p.name}”`;
  let subject: string;
  let line: string;
  let link: string;
  let cta: string;
  if (q.kind === "test") {
    subject = "Test email from LM Data Universe";
    line = "This is a test email. If you can read it, LM Data Universe can send email.";
    link = appUrl;
    cta = "Open LM Data Universe";
  } else if (q.kind === "mention") {
    subject = `${p.by} mentioned you in ${p.doc}`;
    line = `${p.by} mentioned you in a comment in “${p.doc}”:\n\n“${p.body}”`;
    link = `${appUrl}/doc/${p.doc_id}?comment=${p.comment_id}`;
    cta = "Open the comment";
  } else if (q.kind === "invite") {
    subject = `${p.by} invited you to ${p.name} on LM Data Universe`;
    line = `${p.by} invited you to ${what} as ${roleWord}. Create an account with this email address to get access.`;
    link = `${appUrl}/signup?email=${encodeURIComponent(q.to_email)}`;
    cta = "Create your account";
  } else {
    subject = `${p.by} shared ${p.name} with you`;
    line = `${p.by} gave you access to ${what} as ${roleWord}.`;
    link = p.target === "document" ? `${appUrl}/doc/${p.id}` : appUrl;
    cta = "Open LM Data Universe";
  }
  const text = `${line}\n\n${cta}: ${link}\n`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f2330;max-width:520px">
<p>${esc(line).replace(/\n/g, "<br>")}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#5a43d9;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(cta)}</a></p>
<p style="color:#6b7280;font-size:13px">You received this because someone used your email address in LM Data Universe.</p></div>`;
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = req.headers.get("x-worker-secret") ?? "";
  if (!secret) return new Response("Bad request", { status: 400 });
  const cfg = mailConfig();
  const appUrl = cfg.appUrl || "http://localhost:3000";
  // Not configured yet: leave the queue alone so nothing is lost, and say so in the app.
  if (!cfg.key || !cfg.from) {
    await reportMail(db, secret, cfg, false, "The SendGrid key and sender address aren't set");
    return new Response(JSON.stringify({ skipped: "LMDU_SENDGRID_API_KEY / LMDU_MAIL_FROM not set" }), { status: 503 });
  }

  const { data, error } = await db.rpc("notify_claim", { p_secret: secret, p_limit: 50 });
  if (error) return new Response(error.message, { status: 403 });
  let sent = 0;
  let setupError: string | null = null;
  for (const q of (data ?? []) as Queued[]) {
    const m = render(q, appUrl);
    const r = await sendMail(cfg, { to: [q.to_email], subject: m.subject, text: m.text, html: m.html, category: q.kind, args: { lmdu_note: String(q.id) } });
    if (r.setup) setupError = r.error;
    await db.rpc("notify_done", { p_secret: secret, p_id: q.id, p_error: r.error });
    if (!r.error) sent++;
  }
  if (data?.length) await reportMail(db, secret, cfg, setupError === null, setupError);
  return new Response(JSON.stringify({ sent, claimed: data?.length ?? 0 }), { headers: { "Content-Type": "application/json" } });
});
