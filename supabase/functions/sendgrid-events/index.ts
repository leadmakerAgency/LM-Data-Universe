// sendgrid-events: receives SendGrid's Event Webhook (delivered, deferred,
// bounce, dropped, spam report) and hands the events to the database, which
// updates the delivery log and the bounce list.
//
// SendGrid → Settings → Mail Settings → Event Webhook:
//   URL      https://<project>.supabase.co/functions/v1/sendgrid-events
//   Events   Delivered, Deferred, Bounced, Dropped, Spam Reports
//   Security turn on "Signed Event Webhook" and copy the verification key into
//            the secret LMDU_SENDGRID_WEBHOOK_KEY
//
// Unsigned or wrongly signed requests are refused. Events that don't carry our
// marker (custom argument lmdu_env=lmdu) are ignored by the database, so mail
// from the other app on the same SendGrid account is left alone.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { verifySendGridSignature } from "../_shared/sgverify.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_BYTES = 2_000_000;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = (Deno.env.get("LMDU_SENDGRID_WEBHOOK_KEY") ?? "").trim();
  if (!key) return json({ error: "The event webhook isn't set up (LMDU_SENDGRID_WEBHOOK_KEY)" }, 503);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > MAX_BYTES) return json({ error: "Too large" }, 413);
  const ok = await verifySendGridSignature(
    key,
    req.headers.get("x-twilio-email-event-webhook-signature") ?? "",
    req.headers.get("x-twilio-email-event-webhook-timestamp") ?? "",
    body,
  );
  if (!ok) return json({ error: "Bad signature" }, 401);
  let events: unknown;
  try {
    events = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "Not JSON" }, 400);
  }
  if (!Array.isArray(events)) return json({ error: "Expected a list of events" }, 400);
  const { data, error } = await db.rpc("mail_events_in", { p_events: events });
  if (error) {
    console.error(JSON.stringify({ mail_events_in: error.message }));
    return json({ error: "Could not store the events" }, 500); // SendGrid tries again
  }
  return json({ received: events.length, kept: data ?? 0 }, 200);
});
