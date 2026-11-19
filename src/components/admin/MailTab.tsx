"use client";

// Admin → Email: whether sending works, the week's numbers, a test email, and
// the addresses that are no longer written to (bounced or reported spam).
import { CheckCircle2, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Spinner, useDialogs } from "@/components/ui";
import { errorMessage, supabase } from "@/lib/supabase";
import { toast } from "@/store/toasts";

interface MailOverview {
  status: { configured: boolean; from: string | null; app_url: string | null; checked_at: string | null; error: string | null; last_event_at: string | null };
  week: { sent: number; delivered: number; failed: number; bounced: number; spam: number; notices_sent: number };
  waiting: { automation: number; notices: number; notices_failed: number };
  suppressions: { email: string; reason: "bounced" | "spam"; detail: string | null; at: string }[];
}

const num = (n: number | string) => Number(n).toLocaleString();
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function MailTab() {
  const [m, setM] = useState<MailOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();

  const load = useCallback(async () => {
    const { data, error } = await supabase().rpc("admin_mail");
    if (error) toast.error(errorMessage(error));
    else setM(data as MailOverview);
  }, []);
  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  if (!m) return <Spinner />;
  const s = m.status;

  const test = async () => {
    setBusy(true);
    const { data, error } = await supabase().rpc("admin_test_email");
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`Test email queued for ${data}. It is sent within a minute.`);
    setTimeout(load, 4000);
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-start gap-3">
          {s.configured ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-600" /> : <TriangleAlert size={20} className="mt-0.5 shrink-0 text-amber-600" />}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{s.configured ? "Email is working" : s.checked_at ? "Email isn't set up" : "Email hasn't been checked yet"}</h2>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-gray-500">Sent from</dt>
              <dd>{s.from ?? "not set (LMDU_MAIL_FROM)"}</dd>
              <dt className="text-gray-500">Links point to</dt>
              <dd>{s.app_url ?? "not set (LMDU_APP_URL)"}</dd>
              <dt className="text-gray-500">Last checked</dt>
              <dd>{s.checked_at ? when(s.checked_at) : "never: nothing has been sent yet"}</dd>
              <dt className="text-gray-500">Delivery reports</dt>
              <dd>{s.last_event_at ? `last received ${when(s.last_event_at)}` : "none received yet (SendGrid event webhook)"}</dd>
            </dl>
            {s.error && <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-sm text-red-700">{s.error}</p>}
            {!s.configured && (
              <p className="mt-2 text-sm text-gray-600">
                Set the secrets <code>LMDU_SENDGRID_API_KEY</code>, <code>LMDU_MAIL_FROM</code> and <code>LMDU_APP_URL</code> on the Supabase project (see the README, “Email”),
                then send a test.
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => void load()} title="Refresh">
              <RefreshCw size={13} />
            </Button>
            <Button size="sm" variant="primary" onClick={() => void test()} disabled={busy}>
              <Send size={13} /> {busy ? "Queueing…" : "Send me a test email"}
            </Button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Automation emails (7 days)" value={num(m.week.sent)} sub={`${num(m.week.delivered)} confirmed delivered`} />
        <Stat label="Invites and mentions" value={num(m.week.notices_sent)} sub="sent, 7 days" />
        <Stat label="Failed" value={num(m.week.failed)} sub="not accepted by SendGrid" />
        <Stat label="Bounced or blocked" value={num(m.week.bounced)} />
        <Stat label="Spam reports" value={num(m.week.spam)} />
        <Stat label="Waiting" value={num(Number(m.waiting.automation) + Number(m.waiting.notices))} sub={Number(m.waiting.notices_failed) ? `${num(m.waiting.notices_failed)} invites gave up` : undefined} />
      </div>

      <section className="rounded-lg border border-gray-200 bg-white">
        <header className="border-b border-gray-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold">Addresses not written to</h2>
          <p className="text-xs text-gray-500">An address lands here after a hard bounce or a spam report; automations skip it. Remove it once the address is known to work.</p>
        </header>
        {m.suppressions.length === 0 ? (
          <p className="px-4 py-5 text-sm text-gray-500">None.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Address</th>
                <th className="px-2 py-2 font-medium">Why</th>
                <th className="px-2 py-2 font-medium">Details</th>
                <th className="px-2 py-2 font-medium">Since</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {m.suppressions.map((x) => (
                <tr key={x.email}>
                  <td className="px-4 py-1.5 font-medium">{x.email}</td>
                  <td className="px-2 py-1.5">{x.reason === "spam" ? "Reported spam" : "Bounced"}</td>
                  <td className="max-w-80 truncate px-2 py-1.5 text-gray-600" title={x.detail ?? undefined}>
                    {x.detail}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-gray-600">{when(x.at)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      className="rounded px-1.5 py-0.5 text-xs text-brand-700 hover:bg-brand-50"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Write to ${x.email} again?`,
                          message: x.reason === "spam" ? "This person reported an email as spam. Only remove them if they asked to hear from you again." : "If the address still doesn't exist, the next email bounces and it comes back here.",
                          confirmLabel: "Remove from the list",
                        });
                        if (!ok) return;
                        const { error } = await supabase().rpc("admin_unsuppress", { p_email: x.email });
                        if (error) toast.error(errorMessage(error));
                        void load();
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
