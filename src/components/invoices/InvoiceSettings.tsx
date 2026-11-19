"use client";

// Invoicing settings (business profiles with logo and bank details, numbering,
// tax rates, reminders and email texts), the services catalogue and the
// recurring schedules.
import clsx from "clsx";
import { ImagePlus, Plus, Save, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Input, Label, Select, useDialogs } from "@/components/ui";
import { CATEGORY_LABEL, LANGUAGES, formatNumber, money, type InvoiceKind, type Profile, type Service, type TaxCategory, type TaxRate } from "@/lib/invoices";
import type { InvoiceSettings } from "@/lib/invoiceData";
import { errorMessage, supabase } from "@/lib/supabase";
import { toast } from "@/store/toasts";

const AREA = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50";
const KIND_NAME: Record<InvoiceKind, string> = { invoice: "Invoices", credit_note: "Credit notes", quote: "Quotes", proforma: "Pro forma invoices" };

function Card({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mb-3 mt-0.5 text-xs text-gray-500">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function F({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <Label>{label}</Label>
      {children}
    </label>
  );
}

async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string): Promise<boolean> {
  const { error } = await fn();
  if (error) {
    toast.error(errorMessage(error));
    return false;
  }
  if (ok) toast.success(ok);
  return true;
}

// ---------------------------------------------------------------- profile

function ProfileForm({ docId, profile, canEdit, onChange }: { docId: string; profile: Profile; canEdit: boolean; onChange: () => void }) {
  const [p, setP] = useState(profile);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(p) !== JSON.stringify(profile);
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    const { id, doc_id: _d, is_default: _i, ...rest } = p;
    void _d;
    void _i;
    if (await run(() => supabase().from("invoice_profiles").update({ ...rest, reminder_days: rest.reminder_days.map(Number).filter((n) => Number.isFinite(n)) }).eq("id", id), "Saved")) onChange();
    setBusy(false);
  };
  const uploadLogo = async (file: File) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast.error("Use a PNG, JPG or WebP image (SVG isn't supported in PDFs).");
    if (file.size > 2 * 1024 * 1024) return toast.error("The logo can be at most 2 MB.");
    setBusy(true);
    const path = `${docId}/${crypto.randomUUID()}.${file.type.split("/")[1].replace("jpeg", "jpg")}`;
    const { error } = await supabase().storage.from("invoice-logos").upload(path, file, { contentType: file.type });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    set({ logo_url: supabase().storage.from("invoice-logos").getPublicUrl(path).data.publicUrl });
  };
  return (
    <fieldset disabled={!canEdit || busy} className="space-y-4">
      <div className="flex items-start gap-4">
        <div className="flex h-20 w-40 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-gray-300 bg-gray-50">
          {p.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logo_url} alt="Logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-gray-400">No logo</span>
          )}
        </div>
        {canEdit && (
          <div className="space-y-1.5">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50">
              <ImagePlus size={14} /> Upload logo
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => (e.target.files?.[0] && void uploadLogo(e.target.files[0]), (e.target.value = ""))} />
            </label>
            {p.logo_url && (
              <button type="button" className="block text-xs text-red-600 hover:underline" onClick={() => set({ logo_url: "" })}>
                Remove logo
              </button>
            )}
            <p className="text-[11px] text-gray-500">PNG/JPG, wide logos work best (at least 600 px).</p>
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <F label="Name (shown in the app)"><Input value={p.name} onChange={(e) => set({ name: e.target.value })} /></F>
        <F label="Legal name (on the invoice)"><Input value={p.legal_name} onChange={(e) => set({ legal_name: e.target.value })} /></F>
        <F label="Address" className="sm:col-span-2"><textarea rows={3} className={AREA} value={p.address} onChange={(e) => set({ address: e.target.value })} /></F>
        <F label="Country (2 letters)"><Input value={p.country} maxLength={2} onChange={(e) => set({ country: e.target.value.toUpperCase().slice(0, 2) })} /></F>
        <F label="VAT number"><Input value={p.vat_id} onChange={(e) => set({ vat_id: e.target.value.toUpperCase().replace(/\s+/g, "") })} placeholder="SI12345678" /></F>
        <F label="Company registration number"><Input value={p.reg_no} onChange={(e) => set({ reg_no: e.target.value })} /></F>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={p.vat_registered} onChange={(e) => set({ vat_registered: e.target.checked })} /> VAT registered</label>
        <F label="Email"><Input value={p.email} onChange={(e) => set({ email: e.target.value })} /></F>
        <F label="Phone"><Input value={p.phone} onChange={(e) => set({ phone: e.target.value })} /></F>
        <F label="Website"><Input value={p.website} onChange={(e) => set({ website: e.target.value })} /></F>
        <div />
        <F label="IBAN"><Input value={p.iban} onChange={(e) => set({ iban: e.target.value.toUpperCase() })} /></F>
        <F label="BIC / SWIFT"><Input value={p.bic} onChange={(e) => set({ bic: e.target.value.toUpperCase() })} /></F>
        <F label="Bank"><Input value={p.bank_name} onChange={(e) => set({ bank_name: e.target.value })} /></F>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={p.show_qr} onChange={(e) => set({ show_qr: e.target.checked })} /> Payment QR code on EUR invoices</label>
      </div>
      <h3 className="pt-2 text-sm font-semibold">Defaults for new invoices</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <F label="Currency"><Input value={p.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase().slice(0, 3) })} /></F>
        <F label="Language">
          <Select value={p.language} onChange={(e) => set({ language: e.target.value })}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </Select>
        </F>
        <F label="Payment terms (days)"><Input type="number" min={0} max={365} value={p.terms_days} onChange={(e) => set({ terms_days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} /></F>
        <F label="Design">
          <Select value={p.template} onChange={(e) => set({ template: e.target.value as Profile["template"] })}>
            <option value="classic">Classic</option>
            <option value="modern">Modern</option>
            <option value="minimal">Minimal</option>
            <option value="bold">Bold</option>
          </Select>
        </F>
        <F label="Brand colour"><input type="color" value={p.color} onChange={(e) => set({ color: e.target.value })} className="h-9 w-full cursor-pointer rounded border border-gray-300" /></F>
        <div />
        <F label="Notes" className="sm:col-span-3"><textarea rows={2} className={AREA} value={p.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. Thank you for your business." /></F>
        <F label="Terms" className="sm:col-span-3"><textarea rows={2} className={AREA} value={p.terms} onChange={(e) => set({ terms: e.target.value })} placeholder="e.g. Late payments are charged statutory default interest." /></F>
        <F label="Footer (every page)" className="sm:col-span-3"><Input value={p.footer} onChange={(e) => set({ footer: e.target.value })} placeholder="e.g. Registered at the District Court of Ljubljana, share capital 7,500 EUR" /></F>
      </div>
      <h3 className="pt-2 text-sm font-semibold">Emails and reminders</h3>
      <p className="text-xs text-gray-500">Placeholders: {"{{number}} {{client}} {{total}} {{balance}} {{due_date}} {{issue_date}} {{company}} {{link}}"}</p>
      <div className="grid gap-3">
        <F label="Invoice email subject"><Input value={p.email_subject} onChange={(e) => set({ email_subject: e.target.value })} /></F>
        <F label="Invoice email text"><textarea rows={6} className={AREA} value={p.email_body} onChange={(e) => set({ email_body: e.target.value })} /></F>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={p.reminders_on} onChange={(e) => set({ reminders_on: e.target.checked })} /> Send payment reminders automatically to sent, unpaid invoices</label>
        <F label="Reminder days (relative to the due date, e.g. -3, 3, 10)">
          <Input value={p.reminder_days.join(", ")} onChange={(e) => set({ reminder_days: e.target.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && Math.abs(n) <= 365).slice(0, 6) })} />
        </F>
        <F label="Reminder subject"><Input value={p.reminder_subject} onChange={(e) => set({ reminder_subject: e.target.value })} /></F>
        <F label="Reminder text"><textarea rows={5} className={AREA} value={p.reminder_body} onChange={(e) => set({ reminder_body: e.target.value })} /></F>
      </div>
      {canEdit && (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-gray-100 bg-white pt-3">
          {dirty && <Button onClick={() => setP(profile)}>Discard</Button>}
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy || !p.name.trim()}>
            <Save size={14} /> Save
          </Button>
        </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------- numbering

function SeriesRow({ s, canEdit, onChange }: { s: InvoiceSettings["series"][number]; canEdit: boolean; onChange: () => void }) {
  const [pattern, setPattern] = useState(s.pattern);
  const [next, setNext] = useState(String(s.next_number));
  const [yearly, setYearly] = useState(s.yearly);
  const dirty = pattern !== s.pattern || Number(next) !== s.next_number || yearly !== s.yearly;
  const valid = pattern.includes("#") && Number(next) >= 1;
  return (
    <tr>
      <td className="py-1.5 pr-3 text-sm">{KIND_NAME[s.kind]}</td>
      <td className="py-1.5 pr-3"><Input className="!h-8 font-mono" value={pattern} disabled={!canEdit} onChange={(e) => setPattern(e.target.value)} /></td>
      <td className="py-1.5 pr-3"><Input className="!h-8 w-24" type="number" min={1} value={next} disabled={!canEdit} onChange={(e) => setNext(e.target.value)} /></td>
      <td className="py-1.5 pr-3 text-center"><input type="checkbox" checked={yearly} disabled={!canEdit} onChange={(e) => setYearly(e.target.checked)} /></td>
      <td className="py-1.5 pr-3 font-mono text-xs text-gray-600">{valid ? formatNumber(pattern, Number(next), new Date()) : "needs #"}</td>
      <td className="py-1.5">
        {canEdit && dirty && (
          <Button size="sm" variant="primary" disabled={!valid} onClick={() => void run(() => supabase().from("invoice_series").update({ pattern, next_number: Number(next), yearly }).eq("id", s.id), "Numbering saved").then((ok) => ok && onChange())}>
            Save
          </Button>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- tax rates

function TaxRates({ docId, taxes, canEdit, onChange }: { docId: string; taxes: TaxRate[]; canEdit: boolean; onChange: () => void }) {
  const [rows, setRows] = useState(taxes);
  const [src, setSrc] = useState(taxes);
  if (src !== taxes) {
    setSrc(taxes);
    setRows(taxes);
  }
  const set = (id: string, patch: Partial<TaxRate>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const save = async (t: TaxRate) => {
    const { id, ...rest } = t;
    if (await run(() => supabase().from("invoice_tax_rates").update({ name: rest.name, rate: Number(rest.rate), category: rest.category, note: rest.note }).eq("id", id), "Saved")) onChange();
  };
  const makeDefault = async (id: string) => {
    if (!(await run(() => supabase().from("invoice_tax_rates").update({ is_default: false }).eq("doc_id", docId)))) return;
    if (await run(() => supabase().from("invoice_tax_rates").update({ is_default: true }).eq("id", id))) onChange();
  };
  const add = async () => {
    if (await run(() => supabase().from("invoice_tax_rates").insert({ doc_id: docId, name: "New rate", rate: 0, category: "S", position: rows.length }))) onChange();
  };
  const remove = async (id: string) => {
    if (await run(() => supabase().from("invoice_tax_rates").delete().eq("id", id))) onChange();
  };
  return (
    <div className="space-y-2">
      <table className="w-full">
        <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="pb-1 font-medium">Name</th>
            <th className="pb-1 font-medium">Rate %</th>
            <th className="pb-1 font-medium">Kind</th>
            <th className="pb-1 font-medium">Printed note</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const orig = taxes.find((x) => x.id === t.id);
            const dirty = JSON.stringify(orig) !== JSON.stringify(t);
            return (
              <tr key={t.id}>
                <td className="py-1 pr-2"><Input className="!h-8" value={t.name} disabled={!canEdit} onChange={(e) => set(t.id, { name: e.target.value })} /></td>
                <td className="w-20 py-1 pr-2"><Input className="!h-8" type="number" step="any" min={0} max={100} value={t.rate} disabled={!canEdit} onChange={(e) => set(t.id, { rate: Number(e.target.value) })} /></td>
                <td className="w-48 py-1 pr-2">
                  <Select className="!h-8" value={t.category} disabled={!canEdit} onChange={(e) => set(t.id, { category: e.target.value as TaxCategory })}>
                    {(Object.keys(CATEGORY_LABEL) as TaxCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </Select>
                </td>
                <td className="py-1 pr-2"><Input className="!h-8" value={t.note} disabled={!canEdit} onChange={(e) => set(t.id, { note: e.target.value })} placeholder={t.category === "S" ? "" : "Legal reason, e.g. Reverse charge, Art. 196 VAT Directive"} /></td>
                <td className="whitespace-nowrap py-1">
                  <button className={clsx("rounded p-1", t.is_default ? "text-amber-500" : "text-gray-300 hover:text-amber-500")} title={t.is_default ? "Default for new lines" : "Make it the default"} disabled={!canEdit || t.is_default} onClick={() => void makeDefault(t.id)}>
                    <Star size={14} fill={t.is_default ? "currentColor" : "none"} />
                  </button>
                  {canEdit && dirty && <Button size="sm" variant="primary" onClick={() => void save(t)}>Save</Button>}
                  {canEdit && (
                    <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove (issued invoices keep their rate)" onClick={() => void remove(t.id)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canEdit && <Button size="sm" variant="ghost" onClick={() => void add()}><Plus size={13} /> Add a rate</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- settings page

export function SettingsView({ docId, settings, canEdit, onChange }: { docId: string; settings: InvoiceSettings; canEdit: boolean; onChange: () => void }) {
  const [pid, setPid] = useState(settings.profiles.find((p) => p.is_default)?.id ?? settings.profiles[0]?.id);
  const profile = settings.profiles.find((p) => p.id === pid) ?? settings.profiles[0];
  const { prompt } = useDialogs();
  const addProfile = async () => {
    const name = await prompt({ title: "Another business", label: "Name", confirmLabel: "Add" });
    if (!name) return;
    const base = profile;
    const { data, error } = await supabase()
      .from("invoice_profiles")
      .insert({ doc_id: docId, name, legal_name: name, country: base?.country ?? "", currency: base?.currency ?? "EUR", language: base?.language ?? "en", vat_registered: base?.vat_registered ?? true })
      .select("id")
      .single();
    if (error) return toast.error(errorMessage(error));
    const kinds: [InvoiceKind, string][] = [["invoice", "{YYYY}-{####}"], ["credit_note", "CN-{YYYY}-{####}"], ["quote", "Q-{YYYY}-{####}"], ["proforma", "PF-{YYYY}-{####}"]];
    // A second business needs its own prefix so numbers don't collide.
    const prefix = name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "B";
    await supabase().from("invoice_series").insert(kinds.map(([kind, pattern]) => ({ doc_id: docId, profile_id: data.id, kind, pattern: `${prefix}-${pattern}` })));
    setPid(data.id);
    onChange();
  };
  const makeDefault = async () => {
    if (!profile) return;
    if (!(await run(() => supabase().from("invoice_profiles").update({ is_default: false }).eq("doc_id", docId)))) return;
    if (await run(() => supabase().from("invoice_profiles").update({ is_default: true }).eq("id", profile.id), "Default business changed")) onChange();
  };
  const series = settings.series.filter((s) => s.profile_id === profile?.id).sort((a, b) => Object.keys(KIND_NAME).indexOf(a.kind) - Object.keys(KIND_NAME).indexOf(b.kind));
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {!canEdit && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Only workspace owners can change the invoicing settings.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Label className="!mb-0">Business</Label>
        <Select className="!h-8 max-w-64" value={profile?.id} onChange={(e) => setPid(e.target.value)}>
          {settings.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? " (default)" : ""}</option>)}
        </Select>
        {canEdit && profile && !profile.is_default && <Button size="sm" onClick={() => void makeDefault()}>Make default</Button>}
        {canEdit && <Button size="sm" variant="ghost" onClick={() => void addProfile()}><Plus size={13} /> Another business</Button>}
      </div>
      {profile && (
        <Card title="Business details" hint="Printed on every invoice. Issued invoices keep the details they were issued with.">
          <ProfileForm key={profile.id + JSON.stringify(profile)} docId={docId} profile={profile} canEdit={canEdit} onChange={onChange} />
        </Card>
      )}
      <Card title="Numbering" hint="{YYYY} year, {YY} short year, {MM} month, #### the counter with leading zeros. Numbers are given when an invoice is issued, without gaps; a yearly series starts again at 1 each year.">
        <table className="w-full">
          <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
            <tr><th className="pb-1 font-medium">Type</th><th className="pb-1 font-medium">Pattern</th><th className="pb-1 font-medium">Next</th><th className="pb-1 text-center font-medium">Yearly</th><th className="pb-1 font-medium">Next number</th><th /></tr>
          </thead>
          <tbody>{series.map((s) => <SeriesRow key={s.id + s.next_number + s.pattern} s={s} canEdit={canEdit} onChange={onChange} />)}</tbody>
        </table>
      </Card>
      <Card title="Tax rates" hint="The star marks the rate new lines get. Reverse charge, exempt and export rates print their note on the invoice, as the law requires.">
        <TaxRates docId={docId} taxes={settings.taxes} canEdit={canEdit} onChange={onChange} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- services

export function ServicesEditor({ docId, settings, canEdit, onChange }: { docId: string; settings: InvoiceSettings; canEdit: boolean; onChange: () => void }) {
  const [rows, setRows] = useState(settings.services);
  const [src, setSrc] = useState(settings.services);
  if (src !== settings.services) {
    setSrc(settings.services);
    setRows(settings.services);
  }
  const currency = (settings.profiles.find((p) => p.is_default) ?? settings.profiles[0])?.currency ?? "EUR";
  const set = (id: string, patch: Partial<Service>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const add = async () => {
    if (await run(() => supabase().from("invoice_services").insert({ doc_id: docId, name: "New service", unit: "hour", price: 0, tax_rate_id: settings.taxes.find((t) => t.is_default)?.id ?? null }))) onChange();
  };
  const save = async (s: Service) => {
    if (await run(() => supabase().from("invoice_services").update({ name: s.name, description: s.description, unit: s.unit, price: Number(s.price), tax_rate_id: s.tax_rate_id, active: s.active }).eq("id", s.id), "Saved")) onChange();
  };
  const remove = async (id: string) => {
    if (await run(() => supabase().from("invoice_services").delete().eq("id", id))) onChange();
  };
  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <p className="text-sm text-gray-600">What you charge for. Pick them on an invoice with “Add a service”; the price and tax are copied, so changing them here doesn&apos;t change past invoices.</p>
      {rows.length === 0 && <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">No services yet.</div>}
      {rows.map((s) => {
        const dirty = JSON.stringify(s) !== JSON.stringify(settings.services.find((x) => x.id === s.id));
        return (
          <fieldset key={s.id} disabled={!canEdit} className={clsx("grid grid-cols-[1fr_6rem_8rem_12rem_auto] items-start gap-2 rounded-lg border bg-white p-3", s.active ? "border-gray-200" : "border-gray-200 opacity-60")}>
            <div className="space-y-1.5">
              <Input className="!h-8 font-medium" value={s.name} onChange={(e) => set(s.id, { name: e.target.value })} aria-label="Service name" />
              <textarea rows={1} className={AREA} value={s.description} onChange={(e) => set(s.id, { description: e.target.value })} placeholder="Description (optional, printed under the name)" aria-label="Description" />
            </div>
            <Input className="!h-8" value={s.unit} onChange={(e) => set(s.id, { unit: e.target.value })} placeholder="unit" aria-label="Unit" />
            <Input className="!h-8" type="number" step="any" value={s.price} onChange={(e) => set(s.id, { price: Number(e.target.value) })} aria-label="Price" title={`Price in ${currency}`} />
            <Select className="!h-8" value={s.tax_rate_id ?? ""} onChange={(e) => set(s.id, { tax_rate_id: e.target.value || null })} aria-label="Tax">
              <option value="">Default tax</option>
              {settings.taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-1 text-xs text-gray-600" title="Inactive services are hidden on invoices"><input type="checkbox" checked={s.active} onChange={(e) => set(s.id, { active: e.target.checked })} /> Active</label>
              {canEdit && dirty && <Button size="sm" variant="primary" onClick={() => void save(s)}>Save</Button>}
              {canEdit && <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Remove" onClick={() => void remove(s.id)}><Trash2 size={13} /></button>}
            </div>
          </fieldset>
        );
      })}
      {canEdit && <Button onClick={() => void add()}><Plus size={14} /> Add a service</Button>}
      {rows.length > 0 && <p className="text-xs text-gray-400">Prices in {currency}, without VAT. Example: {money(rows[0].price, currency)} per {rows[0].unit}.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- recurring

interface Recurring {
  id: string;
  template_id: string;
  every: "month" | "quarter" | "year";
  next_run: string;
  until: string | null;
  active: boolean;
  last_invoice: string | null;
  invoices: { bill_name: string; total: number; currency: string; number: string | null } | null;
}

export function RecurringList({ docId, wsId, canEdit }: { docId: string; wsId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<Recurring[] | null>(null);
  const load = async () => {
    const { data, error } = await supabase()
      .from("invoice_recurring")
      .select("id,template_id,every,next_run,until,active,last_invoice,invoices!invoice_recurring_template_id_fkey(bill_name,total,currency,number)")
      .eq("doc_id", docId)
      .order("next_run");
    if (error) return toast.error(errorMessage(error));
    setRows((data as unknown as Recurring[]) ?? []);
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);
  const update = async (id: string, patch: Partial<Recurring>) => {
    if (await run(() => supabase().from("invoice_recurring").update(patch).eq("id", id))) void load();
  };
  const remove = async (id: string) => {
    if (await run(() => supabase().from("invoice_recurring").delete().eq("id", id))) void load();
  };
  if (!rows) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <p className="text-sm text-gray-600">Each schedule copies an invoice into a new draft on its date (every morning), with the dates moved on. You review and issue the drafts. Start one with “Repeat” on an invoice.</p>
      {!rows.length ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">No recurring invoices.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr><th className="px-3 py-2 font-medium">Copy of</th><th className="px-3 py-2 font-medium">Every</th><th className="px-3 py-2 font-medium">Next draft</th><th className="px-3 py-2 font-medium">Until</th><th className="px-3 py-2 font-medium">Active</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <Link className="text-brand-700 hover:underline" href={`/w/${wsId}/invoices/${r.template_id}`}>{r.invoices?.number ?? "Draft"}</Link>
                    <span className="ml-2 text-gray-600">{r.invoices?.bill_name}</span>
                    {r.invoices && <span className="ml-2 text-gray-400">{money(Number(r.invoices.total), r.invoices.currency)}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Select className="!h-7 w-28" value={r.every} disabled={!canEdit} onChange={(e) => void update(r.id, { every: e.target.value as Recurring["every"] })}>
                      <option value="month">month</option><option value="quarter">quarter</option><option value="year">year</option>
                    </Select>
                  </td>
                  <td className="px-3 py-2"><input type="date" className="rounded border border-gray-300 px-1.5 py-0.5" value={r.next_run} disabled={!canEdit} onChange={(e) => e.target.value && void update(r.id, { next_run: e.target.value })} /></td>
                  <td className="px-3 py-2"><input type="date" className="rounded border border-gray-300 px-1.5 py-0.5" value={r.until ?? ""} disabled={!canEdit} onChange={(e) => void update(r.id, { until: e.target.value || null })} /></td>
                  <td className="px-3 py-2"><input type="checkbox" checked={r.active} disabled={!canEdit} onChange={(e) => void update(r.id, { active: e.target.checked })} /></td>
                  <td className="px-3 py-2 text-right">{canEdit && <button className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" title="Stop and remove" onClick={() => void remove(r.id)}><Trash2 size={13} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
