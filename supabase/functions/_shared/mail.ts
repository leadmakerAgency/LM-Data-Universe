// Sending through SendGrid, shared by `deliver` (automation emails) and
// `notify` (invites, shares, mentions, test emails).
//
// Secrets (supabase secrets set …). This Supabase project is shared with
// another app, so ours carry the LMDU_ prefix; the older names still work.
//
//   LMDU_SENDGRID_API_KEY   SendGrid API key with "Mail Send" permission      (was SENDGRID_API_KEY)
//   LMDU_MAIL_FROM          verified sender: "LM Data Universe <notifications@mail.example.com>"  (was NOTIFY_FROM)
//   LMDU_APP_URL            where the app runs: https://data.example.com       (was APP_URL)
//   LMDU_MAIL_DRY_RUN       "1": log emails instead of sending them
//
// Every message carries the category "lmdu" and the custom argument
// lmdu_env=lmdu, which is how the event webhook tells our mail from the other app's.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

export interface MailConfig {
  key: string | null;
  from: { email: string; name?: string } | null;
  appUrl: string;
  dryRun: boolean;
}

const env = (name: string) => (Deno.env.get(name) ?? "").trim() || null;

function parseFrom(from: string): { email: string; name?: string } {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() } : { email: from.trim() };
}

export function mailConfig(): MailConfig {
  const from = env("LMDU_MAIL_FROM") ?? env("NOTIFY_FROM");
  return {
    key: env("LMDU_SENDGRID_API_KEY") ?? env("SENDGRID_API_KEY"),
    from: from ? parseFrom(from) : null,
    appUrl: (env("LMDU_APP_URL") ?? env("APP_URL") ?? "").replace(/\/$/, ""),
    dryRun: env("LMDU_MAIL_DRY_RUN") === "1",
  };
}

export const NOT_SET_UP = "Email isn't set up yet: the SendGrid key and sender address are missing";

export interface Mail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string | null;
  fromName?: string | null;
  subject: string;
  text: string;
  html?: string;
  /** "automation", "invite", "mention"… (the category "lmdu" is always added). */
  category: string;
  /** Returned with every delivery event, e.g. { lmdu_job: "12" }. */
  args?: Record<string, string>;
  /** Files, base64 encoded (SendGrid's limit is 30 MB for the whole message). */
  attachments?: { content: string; filename: string; type: string }[];
}

/** Base64 of bytes, in chunks (spreading a big array into fromCharCode overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface SendResult {
  error: string | null;
  status: number | null;
  /** False when trying again can't help (refused request, wrong key, unverified sender). */
  retry: boolean;
  /** True when the account itself is the problem: the key or the sender. */
  setup: boolean;
}

export async function sendMail(cfg: MailConfig, m: Mail): Promise<SendResult> {
  if (!cfg.key || !cfg.from) return { error: NOT_SET_UP, status: null, retry: true, setup: true };
  const addr = (list?: string[]) => (list?.length ? list.map((email) => ({ email })) : undefined);
  const body = {
    personalizations: [{ to: addr(m.to), cc: addr(m.cc), bcc: addr(m.bcc), custom_args: { lmdu_env: "lmdu", ...(m.args ?? {}) } }],
    from: { email: cfg.from.email, name: m.fromName || cfg.from.name },
    reply_to: m.replyTo ? { email: m.replyTo } : undefined,
    subject: m.subject || "(no subject)",
    content: [{ type: "text/plain", value: m.text || " " }, ...(m.html ? [{ type: "text/html", value: m.html }] : [])],
    categories: ["lmdu", m.category],
    attachments: m.attachments?.length ? m.attachments.map((a) => ({ ...a, disposition: "attachment" })) : undefined,
    // These are notifications people asked for, not campaigns: no rewritten links or tracking pixels.
    tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
  };
  if (cfg.dryRun) {
    console.log(JSON.stringify({ dry_run: true, to: m.to, subject: body.subject, category: m.category, attachments: m.attachments?.map((a) => a.filename) }));
    return { error: null, status: 202, retry: false, setup: false };
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { error: null, status: res.status, retry: false, setup: false };
    const raw = (await res.text()).slice(0, 600);
    let detail = raw;
    try {
      const first = (JSON.parse(raw) as { errors?: { message?: string; field?: string }[] }).errors?.[0];
      if (first?.message) detail = first.field ? `${first.message} (${first.field})` : first.message;
    } catch {
      /* not JSON: keep the text */
    }
    const setup = res.status === 401 || res.status === 403;
    const hint = res.status === 401 ? "SendGrid didn't accept the API key" : res.status === 403 ? "SendGrid refused the sender or the key's permissions" : `SendGrid ${res.status}`;
    // 4xx other than "too many requests" won't get better by trying again.
    const retry = res.status === 429 || res.status >= 500;
    return { error: `${hint}: ${detail}`.slice(0, 500), status: res.status, retry, setup };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: null, retry: true, setup: false };
  }
}

/** Tells the database whether email works, for the banner and the admin page. */
export async function reportMail(db: SupabaseClient, secret: string, cfg: MailConfig, configured: boolean, error: string | null) {
  const { error: err } = await db.rpc("mail_report", {
    p_secret: secret,
    p_configured: configured,
    p_from: cfg.from?.email ?? null,
    p_app_url: cfg.appUrl || null,
    p_error: error,
  });
  if (err) console.error(JSON.stringify({ mail_report: err.message }));
}
