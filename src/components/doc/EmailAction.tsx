"use client";

// The "Send an email" action of an automation: recipients, subject, message
// (Markdown), a tag picker that inserts at the cursor, optional sender name /
// Reply-To / CC / BCC, and a preview filled from a real record.
import clsx from "clsx";
import { ChevronDown, ChevronRight, Eye, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Input } from "@/components/ui";
import { errorMessage } from "@/lib/supabase";
import { DOCUMENT_TAGS, columnTags, insertTag, unknownTag, type MailTag } from "@/lib/mailTags";
import type { DocColumn } from "@/lib/types";
import { tableColumns } from "@/store/docStore";
import { renderHtml } from "../../../supabase/functions/_shared/markdown";

export interface EmailAction {
  type: "email";
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  from_name?: string;
}

type FieldName = "to" | "subject" | "body" | "cc" | "bcc" | "reply_to" | "from_name";
const FIELD_LABEL: Record<FieldName, string> = { to: "To", subject: "Subject", body: "Message", cc: "CC", bcc: "BCC", reply_to: "Reply-To", from_name: "Sender name" };

export interface EmailStatus {
  configured: boolean;
  from: string | null;
  app_url: string | null;
  checked_at: string | null;
  error?: string | null;
}

interface Preview {
  row: number;
  emails: { index: number; to: string[]; cc: string[]; bcc: string[]; reply_to: string | null; from_name: string; subject: string; body: string; suppressed: string[]; problem: string | null }[];
}

/** The first problem with an email action's tags, as a sentence (null: fine). */
export function emailProblem(act: EmailAction, cols: DocColumn[]): string | null {
  for (const f of Object.keys(FIELD_LABEL) as FieldName[]) {
    const bad = unknownTag(act[f] ?? "", cols, tableColumns);
    if (bad) return `${FIELD_LABEL[f]}: {{${bad}}} isn't a column of this table or a known placeholder`;
  }
  if (!act.to.trim()) return "Add who the email goes to";
  return null;
}

export function EmailActionEditor({
  action,
  cols,
  onChange,
  preview,
  status,
}: {
  action: EmailAction;
  cols: DocColumn[];
  onChange: (patch: Partial<EmailAction>) => void;
  /** Asks the server what this email would say; null when it can't be previewed yet. */
  preview: (() => Promise<Preview>) | null;
  status: EmailStatus | null;
}) {
  // Where the cursor last was, so a clicked tag lands there.
  const [focus, setFocus] = useState<{ field: FieldName; start: number | null; end: number | null }>({ field: "body", start: null, end: null });
  const [more, setMore] = useState(!!(action.cc || action.bcc || action.reply_to || action.from_name));
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tags = useMemo(() => columnTags(cols, tableColumns), [cols]);
  const problem = emailProblem(action, cols);

  const track = (field: FieldName) => ({
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => setFocus({ field, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }),
    onSelect: (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => setFocus({ field, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }),
  });
  const add = (tag: string) => {
    const current = action[focus.field] ?? "";
    const next = insertTag(current, tag, focus.start, focus.end);
    onChange({ [focus.field]: next.text });
    setFocus({ field: focus.field, start: next.cursor, end: next.cursor });
  };
  const match = (t: MailTag) => !query.trim() || `${t.name} ${t.label}`.toLowerCase().includes(query.trim().toLowerCase());
  const runPreview = async () => {
    if (!preview) return;
    setBusy(true);
    setPreviewError(null);
    try {
      setShown(await preview());
    } catch (e) {
      setShown(null);
      setPreviewError(errorMessage(e));
    }
    setBusy(false);
  };
  const mail = shown?.emails[0];

  return (
    <div className="space-y-2">
      <Input value={action.to} onChange={(e) => onChange({ to: e.target.value })} {...track("to")} placeholder="To: sales@example.com, {{Email}}" aria-label="To" />
      <Input value={action.subject} onChange={(e) => onChange({ subject: e.target.value })} {...track("subject")} placeholder="Subject: {{Name}} is now {{Status}}" aria-label="Subject" />
      <textarea
        value={action.body}
        onChange={(e) => onChange({ body: e.target.value })}
        {...track("body")}
        rows={6}
        aria-label="Message"
        placeholder={"Message, e.g.\nHello {{Name|there}},\n\nYour order is **{{Status}}**. [Open it]({{record_link}})"}
        className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
      <p className="text-xs text-gray-500">
        Formatting: <code>**bold**</code>, <code>*italic*</code>, <code>[text](https://…)</code>, lines starting with <code>-</code> for a list. A fallback for empty
        values: <code>{"{{Name|there}}"}</code>.
      </p>

      <div className="rounded-md border border-gray-200 bg-gray-50/60 p-2">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs font-medium text-gray-600">Insert into {FIELD_LABEL[focus.field]}</span>
          <div className="relative ml-auto">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a column"
              aria-label="Find a column"
              className="h-6 w-40 rounded border border-gray-300 bg-white pl-6 pr-2 text-xs outline-none focus:border-brand-500"
            />
          </div>
        </div>
        <div className="scroll-thin max-h-32 space-y-1.5 overflow-y-auto">
          <TagRow title="Columns" tags={tags.columns.filter(match)} onPick={add} />
          {tags.references.some(match) && <TagRow title="Through references" tags={tags.references.filter(match)} onPick={add} />}
          <TagRow title="Document" tags={DOCUMENT_TAGS.filter(match)} onPick={add} />
        </div>
      </div>

      <button type="button" className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900" onClick={() => setMore(!more)}>
        {more ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Sender name, Reply-To, CC, BCC
      </button>
      {more && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={action.from_name ?? ""} onChange={(e) => onChange({ from_name: e.target.value })} {...track("from_name")} placeholder="Sender name, e.g. Acme Sales" aria-label="Sender name" />
          <Input value={action.reply_to ?? ""} onChange={(e) => onChange({ reply_to: e.target.value })} {...track("reply_to")} placeholder="Reply-To: sales@example.com" aria-label="Reply-To" />
          <Input value={action.cc ?? ""} onChange={(e) => onChange({ cc: e.target.value })} {...track("cc")} placeholder="CC" aria-label="CC" />
          <Input value={action.bcc ?? ""} onChange={(e) => onChange({ bcc: e.target.value })} {...track("bcc")} placeholder="BCC" aria-label="BCC" />
          <p className="text-xs text-gray-500 sm:col-span-2">
            Emails are sent from {status?.from ? <code>{status.from}</code> : "the app's address"}; replies go to Reply-To when it is set.
          </p>
        </div>
      )}

      {problem && <p className="text-xs text-red-600">{problem}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void runPreview()} disabled={!preview || busy || !!problem} title={preview ? "Fill the email from the newest record" : "Pick a table first"}>
          <Eye size={13} /> {busy ? "Filling…" : shown ? "Refresh preview" : "Preview"}
        </Button>
        {shown && (
          <button type="button" className="text-xs text-gray-500 hover:text-gray-800" onClick={() => setShown(null)}>
            Hide
          </button>
        )}
        {previewError && <span className="text-xs text-red-600">{previewError}</span>}
      </div>
      {mail && (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white text-sm">
          <div className="space-y-0.5 border-b border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <div>
              <span className="text-gray-400">Record</span> #{shown.row}
            </div>
            <div>
              <span className="text-gray-400">From</span> {mail.from_name ? `${mail.from_name} · ` : ""}
              {status?.from ?? "the app's address"}
            </div>
            <div className={clsx(!mail.to.length && "text-red-600")}>
              <span className="text-gray-400">To</span> {mail.to.length ? mail.to.join(", ") : "no valid address for this record"}
            </div>
            {mail.cc.length > 0 && (
              <div>
                <span className="text-gray-400">CC</span> {mail.cc.join(", ")}
              </div>
            )}
            {mail.bcc.length > 0 && (
              <div>
                <span className="text-gray-400">BCC</span> {mail.bcc.join(", ")}
              </div>
            )}
            {mail.reply_to && (
              <div>
                <span className="text-gray-400">Reply-To</span> {mail.reply_to}
              </div>
            )}
            {mail.suppressed.length > 0 && <div className="text-amber-700">Won&apos;t be sent to {mail.suppressed.join(", ")}: that address bounced or reported spam before.</div>}
            <div className="pt-1 text-sm font-semibold text-gray-900">{mail.subject || "(no subject)"}</div>
          </div>
          {/* renderHtml escapes everything and only writes its own tags. */}
          <div className="mail-preview px-3 py-2" dangerouslySetInnerHTML={{ __html: renderHtml(mail.body) }} />
        </div>
      )}
    </div>
  );
}

function TagRow({ title, tags, onPick }: { title: string; tags: MailTag[]; onPick: (name: string) => void }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-full text-[10px] font-medium uppercase tracking-wide text-gray-400">{title}</span>
      {tags.map((t) => (
        <button
          key={t.name}
          type="button"
          // Keep the cursor where it is in the field being edited.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(t.name)}
          title={`${t.hint ?? t.label}: {{${t.name}}}`}
          className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Shown where emails are set up when sending isn't possible yet. */
export function EmailStatusBanner({ status }: { status: EmailStatus | null }) {
  if (!status || status.configured) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="font-medium">Emails can&apos;t be sent yet</div>
      <p className="mt-0.5 text-amber-800">
        The app isn&apos;t connected to its email service{status.checked_at ? "" : " (not checked yet)"}. Automations are saved and webhooks work, but email actions will
        wait and then fail until an administrator finishes the email setup.
      </p>
    </div>
  );
}
