// The workspace hub: a hidden document per workspace (documents.kind = 'hub')
// whose pages are the permanent sidebar sections: Clients, Pipeline, Planning,
// Files & assets, and any sections people add. See docs/workspace-hub-plan.md.
import { addTablesToDoc, type DocSpec } from "./docBuilder";
import { errorMessage, supabase } from "./supabase";
import type { DocColumn, WidgetType } from "./types";

export type SectionIcon = "users" | "kanban" | "gantt" | "images" | "list" | "calendar";

export interface HubSection {
  /** Stable key used in the address: /w/<workspace>/<key>. */
  key: string;
  label: string;
  icon: SectionIcon;
  /** The hub page holding the section's shared views, and the table it shows. */
  page: string;
  table: string;
  /** One of the four standard sections (they can be hidden, not removed). */
  builtin?: boolean;
  hidden?: boolean;
  /** What "+ New" says: "Deal", "Task"… */
  noun: string;
}

export interface HubConfig {
  version: 1;
  /** The Clients table: every section's table has a Reference column to it. */
  clients: string;
  contacts?: string;
  sections: HubSection[];
}

export const HUB_STAGES = ["Lead", "Proposal", "Negotiation", "Won", "Lost"];
export const HUB_STATUS = ["To do", "In progress", "Review", "Done"];
const money = { numMode: "currency" as const, decimals: 0 };

/** The standard tables and the first view of each section. Starts empty. */
export const HUB_SPEC: DocSpec = {
  name: "Workspace hub",
  tables: [
    {
      name: "Clients",
      columns: [
        { label: "Client", type: "Text" },
        { label: "Status", type: "Choice", options: { choices: ["Prospect", "Active", "Paused", "Former"] } },
        { label: "Account owner", type: "Text" },
        { label: "Industry", type: "Text" },
        { label: "Website", type: "Text", options: { textFormat: "hyperlink" } },
        { label: "Logo", type: "Attachments" },
        { label: "Open value", type: "Numeric", formula: 'SUM(r.Value for r in Deals.lookupRecords(Client=$id) if r.Stage not in ["Won", "Lost"])', options: money },
        { label: "Won value", type: "Numeric", formula: 'SUM(r.Value for r in Deals.lookupRecords(Client=$id) if r.Stage == "Won")', options: money },
        { label: "Open tasks", type: "Int", formula: 'len([t for t in Tasks.lookupRecords(Client=$id) if t.Status != "Done"])' },
        { label: "Overdue tasks", type: "Int", formula: 'len([t for t in Tasks.lookupRecords(Client=$id) if t.Status != "Done" and t.Due and t.Due < TODAY()])' },
        { label: "Files", type: "Int", formula: "len(Files.lookupRecords(Client=$id))" },
        { label: "Notes", type: "Text", options: { textFormat: "markdown", wrap: true } },
      ],
      rows: [],
    },
    {
      name: "Contacts",
      columns: [
        { label: "Name", type: "Text" },
        { label: "Client", type: "Ref", refTable: "Clients", visibleCol: "Client" },
        { label: "Role", type: "Text" },
        { label: "Email", type: "Text" },
        { label: "Phone", type: "Text" },
      ],
      rows: [],
    },
    {
      name: "Deals",
      columns: [
        { label: "Deal", type: "Text" },
        { label: "Client", type: "Ref", refTable: "Clients", visibleCol: "Client" },
        { label: "Stage", type: "Choice", options: { choices: HUB_STAGES } },
        { label: "Value", type: "Numeric", options: money },
        { label: "Probability", type: "Numeric", options: { numMode: "percent", decimals: 0 } },
        { label: "Close date", type: "Date" },
        { label: "Owner", type: "Text" },
        { label: "Files", type: "Attachments" },
      ],
      rows: [],
    },
    {
      name: "Tasks",
      columns: [
        { label: "Task", type: "Text" },
        { label: "Client", type: "Ref", refTable: "Clients", visibleCol: "Client" },
        { label: "Deal", type: "Ref", refTable: "Deals", visibleCol: "Deal" },
        { label: "Status", type: "Choice", options: { choices: HUB_STATUS } },
        { label: "Assignee", type: "Text" },
        { label: "Start", type: "Date" },
        { label: "Due", type: "Date" },
        { label: "Waits for", type: "RefList", refTable: "Tasks", visibleCol: "Task" },
        { label: "Progress", type: "Numeric", options: { numMode: "percent", decimals: 0 } },
        { label: "Files", type: "Attachments" },
      ],
      rows: [],
    },
    {
      name: "Files",
      columns: [
        { label: "Name", type: "Text" },
        { label: "Client", type: "Ref", refTable: "Clients", visibleCol: "Client" },
        { label: "Deal", type: "Ref", refTable: "Deals", visibleCol: "Deal" },
        { label: "Kind", type: "Choice", options: { choices: ["Data", "Contract", "Creative", "Report", "Other"] } },
        { label: "File", type: "Attachments" },
        { label: "Received", type: "Date" },
        { label: "Notes", type: "Text" },
      ],
      rows: [],
    },
  ],
  pages: [
    {
      name: "Clients",
      widgets: [{ type: "table", table: "Clients", title: "All clients", height: 600 }],
    },
    {
      name: "Pipeline",
      widgets: [
        { type: "board", table: "Deals", title: "Pipeline", height: 600, options: { labels: { boardCol: "Stage", boardSum: "Value", tileTitle: "Deal", tileFields: ["Client", "Value", "Close date", "Owner"], tileCover: "Files" } } },
        { type: "table", table: "Deals", title: "All deals", height: 600 },
      ],
    },
    {
      name: "Planning",
      widgets: [
        { type: "timeline", table: "Tasks", title: "Plan", height: 600, options: { tlZoom: "week", labels: { tlStart: "Start", tlEnd: "Due", tlGroup: "Client", tlDeps: "Waits for", tlProgress: "Progress", tileTitle: "Task", tileColor: "Status" } } },
        { type: "board", table: "Tasks", title: "By status", height: 600, options: { labels: { boardCol: "Status", tileTitle: "Task", tileFields: ["Client", "Assignee", "Due"] } } },
      ],
    },
    {
      name: "Files & assets",
      widgets: [
        { type: "gallery", table: "Files", title: "All files", height: 600, options: { galMode: "files", galSize: "medium", labels: { tileTitle: "Name", tileCover: "File", galGroup: "Client" } } },
        { type: "table", table: "Files", title: "List", height: 600 },
      ],
    },
  ],
};

const STANDARD: { key: string; label: string; icon: SectionIcon; page: string; table: string; noun: string }[] = [
  { key: "clients", label: "Clients", icon: "users", page: "Clients", table: "Clients", noun: "Client" },
  { key: "pipeline", label: "Pipeline", icon: "kanban", page: "Pipeline", table: "Deals", noun: "Deal" },
  { key: "planning", label: "Planning", icon: "gantt", page: "Planning", table: "Tasks", noun: "Task" },
  { key: "files", label: "Files & assets", icon: "images", page: "Files & assets", table: "Files", noun: "File" },
];

/** Reads a hub's configuration (null when it isn't set up yet). */
export function hubConfig(raw: unknown): HubConfig | null {
  const c = raw as Partial<HubConfig> | null;
  return c && Array.isArray(c.sections) && typeof c.clients === "string" ? (c as HubConfig) : null;
}

/** Adds the standard tables, pages and sections to a new, empty hub. */
export async function setUpHub(docId: string): Promise<HubConfig> {
  const tableIds = await addTablesToDoc(docId, HUB_SPEC.tables, HUB_SPEC.pages);
  const { data: pages, error } = await supabase().from("doc_pages").select("id,name").eq("doc_id", docId);
  if (error) throw new Error(errorMessage(error));
  const pageId = (name: string) => (pages as { id: string; name: string }[]).find((p) => p.name === name)?.id ?? "";
  const config: HubConfig = {
    version: 1,
    clients: tableIds.get("Clients")!,
    contacts: tableIds.get("Contacts"),
    sections: STANDARD.map((s) => ({ key: s.key, label: s.label, icon: s.icon, page: pageId(s.page), table: tableIds.get(s.table)!, builtin: true, noun: s.noun })),
  };
  await saveHubConfig(docId, config);
  return config;
}

export async function saveHubConfig(docId: string, config: HubConfig) {
  const { error } = await supabase().rpc("set_hub_config", { p_doc: docId, p_config: config });
  if (error) throw new Error(errorMessage(error));
}

/** The workspace's hub, made (and set up) the first time. */
export async function openHub(workspaceId: string): Promise<{ id: string; config: HubConfig | null }> {
  const { data, error } = await supabase().rpc("ensure_hub", { p_workspace: workspaceId });
  if (error) throw new Error(errorMessage(error));
  const r = data as { id: string; created: boolean; ready: boolean };
  if (r.created) return { id: r.id, config: await setUpHub(r.id) };
  const { data: doc } = await supabase().from("documents").select("hub_config").eq("id", r.id).maybeSingle();
  return { id: r.id, config: hubConfig(doc?.hub_config) };
}

/** A section's Reference column to Clients (how its records belong to a client). */
export function clientColumn(cols: DocColumn[], clientsTable: string): DocColumn | undefined {
  return cols.find((c) => (c.type === "Ref" || c.type === "RefList") && c.options.refTable === clientsTable && !c.is_formula);
}

/** The view types a section can switch between. */
export const VIEW_TYPES: { type: WidgetType; label: string }[] = [
  { type: "board", label: "Board" },
  { type: "table", label: "Table" },
  { type: "timeline", label: "Timeline" },
  { type: "gallery", label: "Gallery" },
  { type: "calendar", label: "Calendar" },
];

/** Columns a new custom section starts with, by its purpose. */
export function customSectionColumns(purpose: WidgetType): { label: string; type: DocColumn["type"]; options?: DocColumn["options"] }[] {
  const base: { label: string; type: DocColumn["type"]; options?: DocColumn["options"] }[] = [
    { label: "Name", type: "Text" },
    { label: "Status", type: "Choice", options: { choices: purpose === "gallery" ? ["Draft", "Approved", "Published"] : ["To do", "In progress", "Done"] } },
    { label: "Owner", type: "Text" },
  ];
  if (purpose === "timeline" || purpose === "calendar") base.push({ label: "Start", type: "Date" }, { label: "End", type: "Date" });
  else base.push({ label: "Date", type: "Date" });
  base.push({ label: "Files", type: "Attachments" }, { label: "Notes", type: "Text" });
  return base;
}

/** A unique key for a new section from its name. */
export function sectionKey(label: string, taken: string[]): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "section";
  const reserved = new Set([...taken, "overview", "clients", "documents", "invoices"]);
  let key = base;
  for (let i = 2; reserved.has(key); i++) key = `${base}-${i}`;
  return key;
}
