// The audit log (Phase 6): reading it through `audit_events`, describing
// events in words, and downloading it as CSV. Administrators read everything,
// team owners their team, document owners their document.
import { supabase } from "./supabase";

export interface AuditEvent {
  id: number;
  at: string;
  actor: string | null;
  actor_email: string | null;
  event: string;
  team_id: string | null;
  team_name: string | null;
  workspace_id: string | null;
  doc_id: string | null;
  doc_name: string | null;
  target: string | null;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  team?: string | null;
  doc?: string | null;
  from?: string | null;
  to?: string | null;
  /** Event name or prefix ("doc." for all document events). */
  event?: string | null;
  /** Part of the actor's email. */
  actor?: string | null;
}

export const AUDIT_EVENT_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "doc.", label: "Documents" },
  { prefix: "member.", label: "Sharing and members" },
  { prefix: "share_link.", label: "Public links" },
  { prefix: "access_rules.", label: "Access rules" },
  { prefix: "integrations.", label: "Webhooks and automations" },
  { prefix: "api_key.", label: "API keys" },
  { prefix: "team.", label: "Teams" },
  { prefix: "plan.", label: "Plans" },
  { prefix: "admin.", label: "Administrators" },
];

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** One line saying what happened (without who and when). */
export function describeEvent(e: AuditEvent): string {
  const d = e.details ?? {};
  const doc = e.doc_name ? `"${e.doc_name}"` : "a document";
  const resource = (r: unknown) =>
    r === "document" ? doc : r === "workspace" ? "a workspace" : e.team_name ? `team "${e.team_name}"` : "a team";
  switch (e.event) {
    case "doc.created":
      return d.copy_of ? `Created ${doc} as a copy` : `Created ${doc}`;
    case "doc.renamed":
      return `Renamed "${str(d.from)}" to "${str(d.to)}"`;
    case "doc.moved":
      return `Moved ${doc} to another workspace`;
    case "doc.trashed":
      return `Moved ${doc} to the trash`;
    case "doc.restored":
      return `Restored ${doc} from the trash`;
    case "doc.deleted":
      return `Deleted ${e.target ? `"${e.target}"` : "a document"} permanently`;
    case "doc.settings_changed":
      return `Changed the settings of ${doc}`;
    case "member.added":
      return `Gave ${str(e.target) || "someone"} ${str(d.role)} access to ${resource(d.resource)}`;
    case "member.invited":
      return `Invited ${str(e.target)} as ${str(d.role)} to ${resource(d.resource)}`;
    case "member.role_changed":
      return `Changed ${str(e.target) || "someone"} from ${str(d.from)} to ${str(d.to)} on ${resource(d.resource)}`;
    case "member.removed":
      return `Removed ${str(e.target) || "someone"} (${str(d.role)}) from ${resource(d.resource)}`;
    case "share_link.created":
      return `Created a public ${d.role === "editor" ? "edit" : "view"} link to ${doc}${d.allow_anonymous ? " (no sign-in needed)" : ""}`;
    case "share_link.revoked":
      return `Revoked a public link to ${doc}`;
    case "access_rules.changed":
      return `Changed the access rules of ${doc}`;
    case "integrations.changed":
      return `Changed webhooks or automations of ${doc}`;
    case "api_key.created":
      return `Created API key "${str(e.target)}"`;
    case "api_key.revoked":
      return `Revoked API key "${str(e.target)}"`;
    case "team.created":
      return `Created team "${str(e.target)}"`;
    case "team.renamed":
      return `Renamed team "${str(d.from)}" to "${str(d.to)}"`;
    case "team.deleted":
      return `Deleted team "${str(e.target)}"`;
    case "plan.changed":
      return `Changed the plan of ${d.account === "team" ? `team "${str(e.target)}"` : str(e.target)} from ${str(d.from)} to ${str(d.to)}`;
    case "admin.added":
      return `Made ${str(e.target)} an administrator`;
    case "admin.removed":
      return `Removed ${str(e.target)} as an administrator`;
    default:
      return e.event;
  }
}

/** One page of events, newest first. */
export async function fetchAuditPage(q: AuditQuery, limit = 200, before: number | null = null): Promise<AuditEvent[]> {
  const { data, error } = await supabase().rpc("audit_events", {
    p_team: q.team ?? null,
    p_doc: q.doc ?? null,
    p_from: q.from ?? null,
    p_to: q.to ?? null,
    p_event: q.event || null,
    p_actor: q.actor || null,
    p_limit: limit,
    p_before: before,
  });
  if (error) throw error;
  return (data ?? []) as AuditEvent[];
}

/** Every matching event (up to `max`), for downloads. */
export async function fetchAuditAll(q: AuditQuery, max = 50_000): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  let before: number | null = null;
  while (out.length < max) {
    const page = await fetchAuditPage(q, 5000, before);
    out.push(...page);
    if (page.length < 5000) break;
    before = page[page.length - 1].id;
  }
  return out.slice(0, max);
}

export async function auditCsv(events: AuditEvent[]): Promise<string> {
  const Papa = (await import("papaparse")).default;
  return Papa.unparse({
    fields: ["id", "time", "actor", "event", "description", "team", "document", "document_id", "target", "details"],
    data: events.map((e) => [
      e.id,
      e.at,
      e.actor_email ?? (e.actor ? e.actor : "system"),
      e.event,
      describeEvent(e),
      e.team_name ?? "",
      e.doc_name ?? "",
      e.doc_id ?? "",
      e.target ?? "",
      JSON.stringify(e.details ?? {}),
    ]),
  });
}

export async function downloadAuditCsv(q: AuditQuery, filename: string): Promise<number> {
  const events = await fetchAuditAll(q);
  const blob = new Blob([await auditCsv(events)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return events.length;
}
