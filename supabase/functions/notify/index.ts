// notify: sends queued emails (invites, "shared with you", @mentions) through
// SendGrid. Called every minute by pg_cron (see *_notify_delivery.sql) with
// the formula worker's shared secret.
//
// Secrets (supabase secrets set ...):
//   SENDGRID_API_KEY  SendGrid API key with Mail Send permission
//   NOTIFY_FROM       verified sender, e.g. "LM Data Universe <noreply@yourdomain>"
//   APP_URL           where the app runs, e.g. https://data.yourdomain.com
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Queued {
  id: number;
  kind: "invite" | "shared" | "mention";
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
  if (q.kind === "mention") {
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

function parseFrom(from: string): { email: string; name?: string } {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() } : { email: from.trim() };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = req.headers.get("x-worker-secret") ?? "";
  const key = Deno.env.get("SENDGRID_API_KEY");
  const from = Deno.env.get("NOTIFY_FROM");
  const appUrl = (Deno.env.get("APP_URL") ?? "http://localhost:3000").replace(/\/$/, "");
  if (!secret) return new Response("Bad request", { status: 400 });
  // Not configured yet: leave the queue alone so nothing is lost.
  if (!key || !from) return new Response(JSON.stringify({ skipped: "SENDGRID_API_KEY / NOTIFY_FROM not set" }), { status: 503 });

  const { data, error } = await db.rpc("notify_claim", { p_secret: secret, p_limit: 50 });
  if (error) return new Response(error.message, { status: 403 });
  let sent = 0;
  for (const q of (data ?? []) as Queued[]) {
    const m = render(q, appUrl);
    let err: string | null = null;
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: q.to_email }] }],
          from: parseFrom(from),
          subject: m.subject,
          content: [
            { type: "text/plain", value: m.text },
            { type: "text/html", value: m.html },
          ],
        }),
      });
      if (!res.ok) err = `SendGrid ${res.status}: ${(await res.text()).slice(0, 500)}`;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    await db.rpc("notify_done", { p_secret: secret, p_id: q.id, p_error: err });
    if (!err) sent++;
  }
  return new Response(JSON.stringify({ sent, claimed: data?.length ?? 0 }), { headers: { "Content-Type": "application/json" } });
});
