"use client";

import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Label, Modal, Select } from "@/components/ui";
import { downloadAuditCsv } from "@/lib/audit";
import { errorMessage, supabase } from "@/lib/supabase";
import type { DocSettings } from "@/lib/types";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

const LOCALES = [
  "en-US", "en-GB", "en-AU", "en-CA", "en-IE", "en-IN", "nl-NL", "nl-BE", "de-DE", "de-AT", "de-CH", "fr-FR", "fr-BE", "fr-CA", "fr-CH",
  "es-ES", "es-MX", "it-IT", "pt-PT", "pt-BR", "da-DK", "sv-SE", "nb-NO", "fi-FI", "pl-PL", "cs-CZ", "hu-HU", "ro-RO", "el-GR", "tr-TR",
  "ru-RU", "uk-UA", "ja-JP", "zh-CN", "zh-TW", "ko-KR", "he-IL", "ar-SA", "hi-IN", "id-ID", "th-TH", "vi-VN",
];
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CHF", "JPY", "CNY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "INR", "BRL", "MXN", "ZAR"];

function supported(kind: "currency" | "timeZone"): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(kind);
  } catch {
    return [];
  }
}

function localeName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
};

function preview(s: DocSettings) {
  const locale = s.locale || undefined;
  const out = { number: "", money: "", time: "" };
  try {
    out.number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(1234567.89);
    out.money = new Intl.NumberFormat(locale, { style: "currency", currency: s.currency || "USD" }).format(1234.5);
    out.time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: s.timezone || undefined }).format(new Date());
  } catch {
    // shown blank for an invalid combination
  }
  return out;
}

const mb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Document settings: locale, default currency and time zone; usage; owners download the document's audit log. */
export function DocSettingsDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc((s) => s.doc);
  const role = useDoc((s) => s.role);
  const canEdit = useDoc((s) => s.canEdit());
  const [draft, setDraft] = useState<DocSettings>(() => ({ ...(doc?.settings ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<{ rows: number; attachment_bytes: number } | null>(null);
  const zones = useMemo(() => supported("timeZone"), []);
  const currencies = useMemo(() => {
    const all = supported("currency");
    const rest = all.filter((c) => !COMMON_CURRENCIES.includes(c));
    return [...COMMON_CURRENCIES, ...rest];
  }, []);
  const p = preview(draft);
  const docId = doc?.id;

  useEffect(() => {
    if (!docId) return;
    let live = true;
    void supabase()
      .from("doc_usage")
      .select("rows,attachment_bytes")
      .eq("doc_id", docId)
      .maybeSingle()
      .then(({ data }) => live && data && setUsage(data as { rows: number; attachment_bytes: number }));
    return () => {
      live = false;
    };
  }, [docId]);

  if (!doc) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(doc.settings ?? {});

  const save = async () => {
    setBusy(true);
    const ok = await useDoc.getState().saveSettings(draft);
    setBusy(false);
    if (ok) {
      toast.success("Document settings saved");
      onClose();
    }
  };

  const downloadLog = async () => {
    try {
      const n = await downloadAuditCsv({ doc: doc.id }, `${doc.name} audit log.csv`);
      toast.info(`${n} event${n === 1 ? "" : "s"} downloaded`);
    } catch (e) {
      toast.error(`Could not download the audit log: ${errorMessage(e)}`);
    }
  };

  const set = (k: keyof DocSettings, v: string) => setDraft((d) => ({ ...d, [k]: v || undefined }));

  return (
    <Modal
      open
      onClose={onClose}
      title="Document settings"
      width={560}
      footer={
        canEdit ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!changed || busy} onClick={save}>
              Save
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="space-y-5 text-sm">
        <section>
          <Label>Locale</Label>
          <Select aria-label="Locale" disabled={!canEdit} value={draft.locale ?? ""} onChange={(e) => set("locale", e.target.value)}>
            <option value="">Each viewer&apos;s browser setting</option>
            {draft.locale && !LOCALES.includes(draft.locale) && <option value={draft.locale}>{draft.locale}</option>}
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {localeName(l)} ({l})
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-gray-500">
            How numbers and month names are written, and how typed numbers are read. Example: <span className="font-mono">{p.number}</span>
          </p>
        </section>

        <section>
          <Label>Currency</Label>
          <Select aria-label="Currency" disabled={!canEdit} value={draft.currency ?? ""} onChange={(e) => set("currency", e.target.value)}>
            <option value="">US dollar (default)</option>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c} · {currencyName(c)}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-gray-500">
            For currency columns that don&apos;t name their own. Example: <span className="font-mono">{p.money}</span>
          </p>
        </section>

        <section>
          <Label>Time zone</Label>
          <Select aria-label="Time zone" disabled={!canEdit} value={draft.timezone ?? ""} onChange={(e) => set("timezone", e.target.value)}>
            <option value="">Each viewer&apos;s own ({browserZone() || "local time"})</option>
            {draft.timezone && !zones.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-gray-500">
            DateTime values are shown and entered in this zone, and <span className="font-mono">TODAY()</span> is today there. Changing it
            recalculates every formula. Now: <span className="font-mono">{p.time}</span>
          </p>
        </section>

        {!canEdit && <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">Only owners and editors can change these settings.</p>}

        {usage && (
          <section className="border-t border-gray-100 pt-4">
            <Label>Usage</Label>
            <p className="text-gray-700">
              {usage.rows.toLocaleString(draft.locale || undefined)} record{usage.rows === 1 ? "" : "s"} · {mb(usage.attachment_bytes)} of attachments
            </p>
          </section>
        )}

        {role === "owner" && (
          <section className="border-t border-gray-100 pt-4">
            <Label>Audit log</Label>
            <p className="mb-2 text-xs text-gray-500">
              Who shared this document, changed its access rules, links, integrations or settings, and when. Kept for a year.
            </p>
            <Button size="sm" onClick={downloadLog}>
              <Download size={14} /> Download as CSV
            </Button>
          </section>
        )}
      </div>
    </Modal>
  );
}
