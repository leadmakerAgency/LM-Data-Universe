# Plan: Invoice generator

Status (19 Nov 2026): **built** — steps 1–8 below, without Stripe (step 9) and
without "invoice a Won deal / done tasks", automation triggers, the zip of PDFs
and the ECB exchange rates. Decisions taken (section 12): the rules and tax
rates follow each business profile's country; EUR by default; invoice languages
English, Slovenian, Croatian, German, Italian, Spanish and French; numbers
`{YYYY}-{####}` restarting every year; several business profiles; quotes, pro
forma invoices and credit notes included; bank transfer with a SEPA QR code for
payment. Emails go through the existing `notify` function (not `deliver`).
See README → Invoices.

Written 19 Nov 2026 from the code and from
how Zoho Invoice, FreshBooks, Invoice Ninja, Bonsai and Stripe Invoicing work,
plus the EU invoice rules (VAT Directive 2006/112/EC, art. 226) and the
e-invoicing mandates now rolling out.

## 1. What it is

A new permanent section, **Invoices**, in every workspace's sidebar (next to
Pipeline, Planning, Files). From it you:

- keep your business details once (logo, address, VAT number, bank account),
- keep a catalogue of the services you charge for,
- write an invoice for a client with a live A4 preview, then issue it with the
  next number, send it by email as a PDF with a link, and record payments,
- and see what is outstanding, overdue and paid, per client and per month.

It is built on what exists: clients come from the hub's **Clients** table, email
goes through the **SendGrid** setup, files go to **Supabase Storage**, every
change is in the audit log, and the client page gets an **Invoices** tab.

## 2. What the best tools do (and what we take)

| Area | Seen in | We build |
| --- | --- | --- |
| Business profile with logo, tax and bank details | all | Yes, several profiles (one per company you invoice from) |
| Client billing details remembered | all | Yes, on the hub's Clients |
| Services / products catalogue with prices and tax | Zoho, FreshBooks, Invoice Ninja | Yes |
| Line items: quantity, unit, price, discount, tax per line | all | Yes |
| Live preview while editing | FreshBooks, invoice-generator sites | Yes, side by side |
| Several designs, brand colour, logo | all | 4 templates, colour, font, show / hide fields |
| Automatic numbering in series | all; legally required in the EU | Yes, gap-free, assigned when issued |
| Quotes / estimates → invoice | Zoho, FreshBooks, Invoice Ninja | Yes |
| Pro forma, deposit and credit notes | Zoho, Stripe (credit notes) | Yes |
| PDF download and email with PDF | all | Yes |
| Online invoice page with link, "viewed" tracking | Stripe hosted page, Zoho portal | Yes |
| Pay online by card / bank | Stripe, Zoho, FreshBooks | Phase 9 (Stripe), optional |
| Partial payments, balance due | Stripe, Zoho | Yes |
| Automatic reminders (before / after due) | FreshBooks, Zoho, Invoice Ninja | Yes |
| Recurring invoices (retainers) | all | Yes |
| Multi-currency and languages | Zoho, Invoice Ninja | Yes: currency per invoice, invoice language per client |
| Reports: aging, revenue, tax summary, export for the accountant | Zoho, FreshBooks | Yes |
| Payment QR code on the PDF (SEPA / national) | EU tools | Yes |
| Structured e-invoice (EN 16931 / Peppol UBL) | EU-focused tools | XML export; sending through Peppol later |
| Time tracking → invoice | FreshBooks, Bonsai | Later (no time tracking in the app yet); "invoice a deal" and "invoice tasks" now |

## 3. Rules the generator must follow

### What an EU invoice must show (VAT Directive art. 226)
Checked before an invoice can be issued; missing items are listed for the user:

1. Date of issue. 2. A sequential number, unique within its series.
3. Seller's VAT number. 4. Buyer's VAT number when the buyer accounts for the VAT
(reverse charge, intra-EU supply). 5. Full names and addresses of seller and
buyer. 6. Quantity and nature of the services. 7. Date of supply, when different
from the issue date. 8. Taxable amount per rate, unit price without VAT,
discounts not in the unit price. 9. VAT rate. 10. VAT amount per rate.
11. When no VAT is charged, the reason (for example *"Reverse charge — Article
196 Directive 2006/112/EC"*, or the national exemption).

### Consequences for how it works
- **Numbers are assigned at issue, not while drafting**, from a series, in one
  locked database step, so there are no gaps and no duplicates.
- **An issued invoice can't be edited or deleted.** Mistakes are fixed with a
  credit note (or voided with a reason while it hasn't been sent, where the
  country allows); both are recorded.
- **What was issued is kept as it was**: seller and buyer details are copied
  into the invoice, and the PDF made at issue is stored with its checksum.
  Changing a client's address later doesn't change old invoices.
- **Kept for 10 years** (the longest EU retention period); the invoices bucket
  is never purged.
- **E-invoicing**: Belgium, Croatia and Poland require structured B2B e-invoices
  from 2026, other countries follow (e.g. Slovenia from 2027), and from 1 July
  2030 all intra-EU B2B invoices must be structured (EN 16931). We export a
  Peppol BIS 3.0 / UBL XML for every issued invoice from the start; actually
  delivering through the Peppol network (and national systems such as Croatia's
  fiscalisation) needs a certified access point and is a later phase, chosen by
  the country you invoice from.

These are general rules; the country you invoice from adds its own (see §12).

## 4. Screens

### 4.1 Invoices section (`/w/<ws>/invoices`)
Tabs: **Invoices · Quotes · Recurring · Services · Settings**.

- Top: **Outstanding**, **Overdue**, **Paid this month**, **Draft** (amounts and counts),
  an aging bar (current, 1–30, 31–60, 61–90, 90+ days).
- List: number, client, issue and due date, total, balance, status chip
  (Draft, Issued, Sent, Viewed, Partly paid, Paid, Overdue, Void, Credited).
  Filters: status, client (the same client filter as other sections), date range,
  currency, profile; search by number, client, reference. Sort by any column.
- Row actions: open, download PDF, send / send reminder, record payment, duplicate,
  credit note. Bulk: download PDFs as a zip, send reminders, export CSV / Excel.
- **+ Invoice** (and + Quote) with the selected client filled in.

### 4.2 Invoice editor (`/w/<ws>/invoices/<id>`)
Left: the form. Right: the invoice as it will look (A4, zoomable, the real template).

- **From**: business profile (logo, address, VAT no., bank shown read-only; edit in Settings).
- **Bill to**: pick a client (search the hub's Clients); their billing name,
  address, VAT number, billing email and language fill in and can be edited
  (saved back to the client on request). **Check VAT number** asks the EU VIES service.
- **Details**: number (shown as "will be 2026-0042 when issued"), issue date, date
  or period of supply, payment terms (Due on receipt, Net 7/14/30/60, custom) →
  due date, reference / PO number, currency (+ exchange rate when not the
  profile's currency), language.
- **Items**: rows with description (short Markdown), quantity, unit (hour, day,
  piece, month, flat), unit price, discount (% or amount), tax rate; add from the
  catalogue (type to search) or free text; drag to reorder; section headings and
  subtotals; keyboard: Enter adds a row, Ctrl+↑/↓ moves it.
- **Totals**: subtotal, discount on the whole invoice, tax per rate, total, paid,
  balance due; a note for zero-rated / reverse-charge lines added automatically.
- **Notes, terms, payment instructions** (defaults from the profile), payment QR
  code on/off, attachments (timesheet, report: files from the client's Files).
- **Design**: template, brand colour, which fields show.
- Autosaves as a draft. Buttons: **Preview PDF**, **Issue** (shows the checklist
  and the number it will get), **Send**, and once issued: **Download**, **Copy
  link**, **Record payment**, **Send reminder**, **Credit note**, **Duplicate**, **Void**.

### 4.3 Send dialog
To (client's billing emails), CC, BCC, subject and message with the same tag
picker as automation emails (`{{client}}`, `{{number}}`, `{{total}}`, `{{due_date}}`,
`{{link}}`), "attach PDF" and "attach e-invoice XML". Sends through the existing
`deliver` function (SendGrid), so delivery, bounces and the email log already work.

### 4.4 Online invoice page (`/i/<token>`, no sign-in)
The invoice in the browser, Download PDF, status (paid / balance due), the
payment details and QR code, and later a **Pay** button. Opening it marks the
invoice "Viewed". Tokens are long random strings; revoked when voided.

### 4.5 Settings
- **Business profiles**: legal name, trading name, address, VAT number, company
  register number, email, phone, website, logo (upload, cropped), bank (IBAN,
  BIC, bank name), default currency, payment terms, notes, terms, footer, template,
  colour, invoice language, default tax rate.
- **Numbering**: per profile and kind: pattern (`{YYYY}-{####}`, `INV-{YY}{MM}-{###}`),
  next number, restart every year; credit notes and quotes have their own series.
- **Tax rates**: name, rate, category (standard, reduced, zero, exempt with reason,
  reverse charge, outside scope), the note printed on the invoice.
- **Reminders**: on/off, days before / after due (e.g. −3, +3, +10, +30), the emails' text.
- **Services** catalogue: name, description, unit, price, currency, tax rate, active.

### 4.6 Elsewhere in the app
- **Client page**: an *Invoices* tab (list + balance), and facts: invoiced this year, outstanding.
- **Overview**: tiles Outstanding and Overdue.
- **Pipeline**: "Create invoice" on a Won deal (one line with the deal and its value,
  or a deposit percentage). **Planning**: select done tasks → invoice them.
- **Automations**: new triggers *invoice paid*, *invoice overdue* (e.g. move the deal, email the account owner).

## 5. Money, rounding and the totals engine

- Amounts are `numeric` in the database (never floating point): quantities 4
  decimals, unit prices 4, money 2 (or the currency's decimals: JPY 0).
- One algorithm, written twice and tested to agree:
  `src/lib/invoiceMath.ts` (live preview) and `public._invoice_totals()` (the
  authority, run at issue):
  1. line net = round(qty × unit price × (1 − line discount %) − line discount amount, 2)
  2. invoice discount spread over lines in proportion to their net
  3. per tax rate: taxable base = Σ line nets; tax = round(base × rate, 2)
     (rounding per rate, as EU invoices show tax per rate)
  4. total = Σ bases + Σ taxes; balance = total − payments
- Rounding half away from zero. Fixture tests cover discounts, several rates,
  reverse charge, credit notes (negative), 0-decimal currencies.

## 6. PDF and templates

- Templates are React components drawn with **@react-pdf/renderer** (4.9), the
  same data and layout for the preview and the file; four designs: Classic,
  Modern, Minimal, Bold. Fonts embedded (Inter, with č, š, ž, ß, ł…), so PDFs
  look the same everywhere.
- The library is loaded only on invoice pages (it is large).
- **At issue** the browser renders the PDF, uploads it to the private `invoices`
  bucket (`<doc>/<invoice>/<number>.pdf`) and the database stores its path and
  SHA-256; that file is the legal copy, attached to emails and served by the
  online page. Drafts are rendered on demand.
- Labels are translated per invoice language (English first; others from a
  small dictionary: Slovenian, Croatian, German, Italian, French, Spanish…).
- **Payment QR**: EPC/SEPA QR ("GiroCode") by default; national formats (UPN QR in
  Slovenia, HUB3 in Croatia) as an option once the country is known.
- **E-invoice**: UBL 2.1 XML (Peppol BIS Billing 3.0, EN 16931) generated from
  the same data at issue and stored next to the PDF.

## 7. Database (Supabase, schema public; the email app is not touched)

All tables carry `doc_id` (the workspace hub), so access follows the workspace
with the existing `my_doc_ids()`: viewers read, editors draft, issue, send and
record payments, owners change settings. RLS on every table; issuing, voiding,
crediting and payments only through `security definer` functions.

| Table | Holds |
| --- | --- |
| `invoice_profiles` | seller details, logo path, bank, defaults, template, colour, language |
| `invoice_series` | profile, kind (invoice, credit_note, quote, proforma), pattern, next number, yearly reset |
| `invoice_tax_rates` | name, rate, category, printed note |
| `invoice_services` | catalogue: name, description, unit, price, currency, tax rate, active |
| `invoices` | kind, status, number, series, profile, client (hub Clients row), seller and client snapshots, dates, terms, currency, fx rate, reference, language, template, notes, terms, discount, totals, tax breakdown, public token, pdf path + sha256, xml path, sent / viewed / paid / voided at, void reason, `credit_of`, `quote_of`, `recurring_id`, created / issued by |
| `invoice_lines` | invoice, position, service, kind (item, heading, subtotal), description, qty, unit, unit price, discount, tax rate id and its rate, category, net |
| `invoice_payments` | invoice, date, amount, method, reference, note, by |
| `invoice_events` | invoice, kind (issued, sent, viewed, reminded, paid, voided, credited), when, details |
| `invoice_recurring` | the template invoice, every (month / quarter / year, day), next run, until, send automatically |
| `invoice_reminder_rules` | profile, offsets in days, email texts |
| `hub Clients` (columns) | Billing name, Billing address, VAT number, Billing email, Invoice language, Payment terms, Currency (added to the standard Clients table) |

Functions:
- `invoice_issue(id)`: checks the art. 226 list, computes totals, takes the next
  number (row lock on the series), copies seller and client, sets Issued,
  creates the public token; returns what the browser needs to make the PDF.
  `invoice_attach_files(id, pdf, sha256, xml)` stores the paths afterwards.
- Trigger: issued invoices and their lines can't change (except status and
  payment fields), can't be deleted.
- `invoice_void(id, reason)`, `invoice_credit_note(id)` (a draft credit note with
  negated lines, `credit_of` set), `invoice_from_quote(id)`, `invoice_duplicate(id)`.
- `invoice_record_payment(id, …)` / `invoice_delete_payment(id)`: update paid, balance and status.
- `invoice_public(token)` (anon): the issued invoice for the online page and a
  short signed link to its PDF; marks Viewed.
- `invoice_send(id, to, cc, bcc, subject, body, attach)`: queues a job for `deliver`.
- `invoice_report(doc, from, to, group)`: revenue, tax per rate, aging, per client.
- Daily `pg_cron` jobs (prefixed `lmdu-`): mark overdue, queue reminders, create
  recurring invoices.
- Storage bucket `invoices` (private); policies by `doc_id` folder like `attachments`.
- Audit log: issued, sent, voided, credited, payment recorded / removed, settings changed.

## 8. Back end (Edge Functions)

- **`deliver`** (existing): new job kind *invoice email*: reads the stored PDF / XML
  with the service role and attaches them (SendGrid attachments), category `lmdu`
  so delivery events update the invoice's email status.
- **`vat-check`** (new): looks a VAT number up in the EU VIES service and returns
  name and address; results cached a day.
- **`fx-rates`** (new, optional): ECB daily reference rates for the exchange-rate default.
- **Stripe (phase 9)**: a Checkout session per invoice from the online page and a
  webhook that records the payment; keys as `LMDU_STRIPE_*` secrets.

## 9. Front end structure

- `src/app/w/[workspaceId]/[[...path]]` gains `invoices`, `invoices/<id>`; `src/app/i/[token]` for the online page.
- `src/components/invoices/`: `InvoicesSection` (tabs, summary, list), `InvoiceEditor`,
  `InvoicePreview`, `LineItems`, `ClientBilling`, `SendDialog`, `PaymentDialog`,
  `Settings/*` (profiles, numbering, taxes, reminders, services), `PublicInvoice`.
- `src/lib/invoiceMath.ts` (totals), `invoiceNumber.ts` (pattern preview),
  `invoicePdf/*` (templates), `invoiceI18n.ts` (labels), `ubl.ts` (XML), `epcQr.ts`.
- Data is loaded per page with Supabase queries (not the hub document store),
  with realtime on `invoices` for status changes; the editor saves drafts with a
  short debounce and shows "Saved".

## 10. Build steps

| Step | What | Sessions |
| --- | --- | --- |
| 1 | Tables, RLS, bucket, settings screens (profiles with logo, numbering, taxes, services), client billing columns; tests | 1.5 |
| 2 | Totals engine (TS + SQL, fixtures), editor with live preview, drafts | 2 |
| 3 | PDF templates and fonts, issue (checklist, numbering, lock, stored PDF), download | 1.5 |
| 4 | Send by email with PDF, online page, viewed tracking, overdue, reminders | 1.5 |
| 5 | Payments, credit notes, void, quotes → invoice, duplicate, pro forma / deposit | 1.5 |
| 6 | Recurring invoices; invoice a Won deal or done tasks; client page tab, Overview tiles, automation triggers | 1 |
| 7 | Reports (aging, revenue, tax summary), CSV / Excel export, zip of PDFs | 1 |
| 8 | E-invoice XML, VIES check, payment QR codes | 1.5 |
| 9 | Online payment with Stripe (optional) | 1.5 |

About 11 sessions without Stripe, 12–13 with it. After step 3 you can already
write, issue and download proper invoices.

## 11. Risks

| Risk | Handling |
| --- | --- |
| Legal requirements differ per country | the issue checklist is data-driven per profile country; country decided before step 1 |
| Rounding differs between preview and stored totals | one algorithm, shared fixtures, the database total is the one printed |
| Someone edits or deletes an issued invoice | blocked by trigger and RLS; corrections only by credit note |
| Number gaps (two people issue at once, a failed upload) | number taken inside the issuing transaction with a row lock; a failed PDF upload can be retried without a new number |
| Large PDF library slows the app | loaded only on invoice pages |
| E-invoicing mandate in your country | XML from day one; network delivery through a certified provider added when required |
| Emails with invoices land in spam | authenticated SendGrid domain (already planned), plain and HTML parts, no tracking pixels |

## 12. Decisions needed

1. **Country you invoice from** (and whether you're VAT-registered): sets the rules,
   default taxes, QR format, e-invoicing deadline and language.
2. **Currency and languages**: default currency; which invoice languages besides English.
3. **Numbering**: format (e.g. `2026-0001`), restart every year?
4. **One or several business profiles** (invoicing from more than one company)?
5. **Online payment**: add Stripe (phase 9), or bank transfer only for now?
6. **Quotes, pro forma, deposits**: needed in the first version?

Sources:
[Dupple: best invoicing software 2026](https://dupple.com/learn/best-invoicing-software) ·
[Rework: invoice management software 2026](https://resources.rework.com/tools/erp-finance/best-invoice-management-software-2026) ·
[Swydo: invoicing software for agencies](https://www.swydo.com/blog/best-invoicing-software/) ·
[Stripe: EU VAT invoice content requirements](https://stripe.com/resources/more/eu-vat-invoice-content-requirements) ·
[VAT Directive art. 226](https://www.legislation.gov.uk/eudr/2006/112/article/226/data.html) ·
[VATupdate: art. 226 explained](https://www.vatupdate.com/2022/05/12/eu-vat-directive-2006-112-ec-explained-art-226-content-of-an-invoice) ·
[Fonoa: Peppol adoption 2026 and ViDA](https://www.fonoa.com/resources/blog/peppol-adoption-europe-2026-mandates-vida) ·
[OriginStamp: EU e-invoicing timeline 2026–2030](https://originstamp.com/en/blog/reader/eu-e-invoicing-mandates-timeline-2026-2030) ·
[Stripe: hosted invoice page](https://docs.stripe.com/invoicing/hosted-invoice-page) ·
[Stripe Invoicing](https://stripe.com/invoices)
