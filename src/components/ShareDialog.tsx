"use client";

import { Check, Code2, Copy, Link2, Mail, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, IconButton, Input, Modal, Select, Spinner } from "./ui";
import { supabase, errorMessage } from "@/lib/supabase";
import { toast } from "@/store/toasts";
import { useDoc } from "@/store/docStore";
import type { Profile, Role } from "@/lib/types";

type Kind = "document" | "workspace" | "team";

interface Props {
  open: boolean;
  onClose: () => void;
  kind: Kind;
  targetId: string;
  title: string;
  canManage: boolean;
  currentUserId: string;
}

interface Row {
  user_id: string;
  role: Role;
  profile?: Profile;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
}

interface ShareLink {
  id: string;
  token: string;
  role: "viewer" | "editor";
  allow_anonymous: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const CONFIG: Record<Kind, { table: string; key: string; share: string; shareArg: string; remove: string; removeArg: string }> = {
  document: { table: "document_members", key: "doc_id", share: "share_document", shareArg: "p_doc", remove: "remove_document_member", removeArg: "p_doc" },
  workspace: { table: "workspace_members", key: "workspace_id", share: "share_workspace", shareArg: "p_workspace", remove: "remove_workspace_member", removeArg: "p_workspace" },
  team: { table: "team_members", key: "team_id", share: "share_team", shareArg: "p_team", remove: "remove_team_member", removeArg: "p_team" },
};

export function shareUrl(token: string) {
  return `${typeof window !== "undefined" ? window.location.origin : ""}/s/${token}`;
}

export function ShareDialog({ open, onClose, kind, targetId, title, canManage, currentUserId }: Props) {
  const [members, setMembers] = useState<Row[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const cfg = CONFIG[kind];

  const load = useCallback(async () => {
    const sb = supabase();
    const { data, error } = await sb.from(cfg.table).select("user_id, role").eq(cfg.key, targetId);
    if (error) return toast.error(errorMessage(error));
    const rows = data as Row[];
    const ids = rows.map((r) => r.user_id);
    const [{ data: profiles }, inv, lk] = await Promise.all([
      ids.length ? sb.from("profiles").select("id,email,full_name").in("id", ids) : Promise.resolve({ data: [] }),
      canManage ? sb.from("pending_invites").select("id,email,role").eq(cfg.key, targetId).order("created_at") : Promise.resolve({ data: [] }),
      canManage && kind === "document"
        ? sb.from("doc_share_links").select("*").eq("doc_id", targetId).is("revoked_at", null).order("created_at")
        : Promise.resolve({ data: [] }),
    ]);
    const byId = new Map(((profiles ?? []) as Profile[]).map((p) => [p.id, p]));
    setMembers(rows.map((r) => ({ ...r, profile: byId.get(r.user_id) })));
    setInvites((inv.data ?? []) as Invite[]);
    setLinks((lk.data ?? []) as ShareLink[]);
  }, [cfg.table, cfg.key, targetId, canManage, kind]);

  useEffect(() => {
    // Fetches members; state is set after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void load();
  }, [open, load]);

  const share = (addr: string, r: Role) => supabase().rpc(cfg.share, { [cfg.shareArg]: targetId, p_email: addr, p_role: r });

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    const { data, error } = await share(email.trim(), role);
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(data ? `Shared with ${email.trim()}` : `Invited ${email.trim()}. They get access when they sign up with that address.`);
    setEmail("");
    void load();
  };

  const changeRole = async (addr: string, newRole: Role) => {
    const { error } = await share(addr, newRole);
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const remove = async (userId: string) => {
    const { error } = await supabase().rpc(cfg.remove, { [cfg.removeArg]: targetId, p_user: userId });
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const cancelInvite = async (id: string) => {
    const { error } = await supabase().from("pending_invites").delete().eq("id", id);
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const hint =
    kind === "workspace"
      ? "Workspace members can open every document in this workspace."
      : kind === "team"
        ? "Team members get their role in every workspace and document of the team."
        : "People listed here have direct access. Members of the document's workspace or team also have access.";

  return (
    <Modal open={open} onClose={onClose} title={`Share “${title}”`} width={560}>
      {canManage && (
        <form onSubmit={invite} className="mb-4 flex gap-2">
          <Input placeholder="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-28">
            <option value="owner">Owner</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </Select>
          <Button variant="primary" disabled={busy || !email.trim()}>
            Invite
          </Button>
        </form>
      )}
      <p className="mb-2 text-xs text-gray-500">{hint}</p>
      {!members ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-gray-100">
          {members.map((m) => {
            const name = m.profile?.full_name || m.profile?.email || "Unknown user";
            return (
              <li key={m.user_id} className="flex items-center gap-3 py-2">
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {name} {m.user_id === currentUserId && <span className="text-gray-400">(you)</span>}
                  </div>
                  <div className="truncate text-xs text-gray-500">{m.profile?.email}</div>
                </div>
                {canManage && m.profile ? (
                  <Select className="h-8 w-28" value={m.role} onChange={(e) => changeRole(m.profile!.email, e.target.value as Role)}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </Select>
                ) : (
                  <span className="text-xs capitalize text-gray-500">{m.role}</span>
                )}
                {(canManage || m.user_id === currentUserId) && (
                  <IconButton title={m.user_id === currentUserId ? "Leave" : "Remove"} onClick={() => remove(m.user_id)}>
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </li>
            );
          })}
          {invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                <Mail size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{i.email}</div>
                <div className="text-xs text-gray-500">Invited · gets access after signing up</div>
              </div>
              <span className="text-xs capitalize text-gray-500">{i.role}</span>
              <IconButton title="Cancel invite" onClick={() => cancelInvite(i.id)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {kind === "document" && canManage && <LinkSharing docId={targetId} links={links} reload={load} />}
    </Modal>
  );
}

/** Public links: anyone with the link can view (or edit), optionally without signing in. */
function LinkSharing({ docId, links, reload }: { docId: string; links: ShareLink[]; reload: () => void }) {
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [anon, setAnon] = useState(true);
  const [expires, setExpires] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState<string | null>(null);

  const create = async () => {
    const { data: auth } = await supabase().auth.getUser();
    const { error } = await supabase()
      .from("doc_share_links")
      .insert({ doc_id: docId, role, allow_anonymous: anon, expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null, created_by: auth.user?.id });
    if (error) return toast.error(errorMessage(error));
    reload();
  };
  const revoke = async (id: string) => {
    const { error } = await supabase().from("doc_share_links").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) return toast.error(errorMessage(error));
    reload();
  };
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Couldn't copy; select the link and copy it yourself.");
    }
  };

  return (
    <div className="mt-5 border-t border-gray-100 pt-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Link2 size={15} /> Share with a link
      </div>
      {links.length > 0 && (
        <ul className="mb-3 space-y-2">
          {links.map((l) => {
            const expired = l.expires_at && new Date(l.expires_at) < new Date();
            return (
              <li key={l.id} className="rounded-md border border-gray-200 p-2">
                <div className="flex items-center gap-2">
                  <input readOnly value={shareUrl(l.token)} className="min-w-0 flex-1 rounded bg-gray-50 px-2 py-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
                  <IconButton title="Copy link" onClick={() => copy(l.token)}>
                    {copied === l.token ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                  </IconButton>
                  {l.role === "viewer" && l.allow_anonymous && (
                    <IconButton title="Embed on a website" onClick={() => setEmbedding(embedding === l.token ? null : l.token)}>
                      <Code2 size={14} />
                    </IconButton>
                  )}
                  <IconButton title="Turn off this link" onClick={() => revoke(l.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
                {embedding === l.token && <EmbedCode token={l.token} />}
                <div className="mt-1 text-xs text-gray-500">
                  Anyone with the link can <b>{l.role === "editor" ? "edit" : "view"}</b>
                  {l.allow_anonymous ? ", no sign-in needed" : ", after signing in"}
                  {l.expires_at && (expired ? " · expired" : ` · until ${new Date(l.expires_at).toLocaleDateString()}`)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select className="h-8 w-32" value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")}>
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
        </Select>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} /> Works without signing in
        </label>
        <label className="flex items-center gap-1.5">
          Expires <Input type="date" className="h-8 w-36" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <Button size="sm" onClick={create}>
          Create link
        </Button>
      </div>
      {role === "editor" && anon && (
        <p className="mt-2 text-xs text-amber-700">Anyone who gets this link can change the document without an account. Changes are still in the history.</p>
      )}
    </div>
  );
}

/** An <iframe> code for a view link: pick the page, whether to show the page list, and the height. */
function EmbedCode({ token }: { token: string }) {
  const pages = useDoc((s) => s.pages);
  const [page, setPage] = useState("");
  const [nav, setNav] = useState(false);
  const [height, setHeight] = useState(600);
  const params = new URLSearchParams({ embed: "1" });
  if (nav) params.set("nav", "1");
  if (page) params.set("page", page);
  const src = `${shareUrl(token)}?${params}`;
  const code = `<iframe src="${src}" width="100%" height="${height}" style="border:0" loading="lazy" title="LM Data Universe"></iframe>`;
  return (
    <div className="mt-2 space-y-2 rounded-md bg-gray-50 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="h-7 !w-auto text-xs" value={page} onChange={(e) => setPage(e.target.value)}>
          <option value="">First page</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={nav} onChange={(e) => setNav(e.target.checked)} /> Show the page list
        </label>
        <label className="flex items-center gap-1.5">
          Height
          <Input type="number" min={200} max={3000} className="h-7 w-20 text-xs" value={height} onChange={(e) => setHeight(Math.max(200, Math.min(3000, Number(e.target.value) || 600)))} />
        </label>
      </div>
      <div className="flex items-start gap-2">
        <textarea readOnly value={code} rows={3} className="min-w-0 flex-1 rounded border border-gray-200 bg-white p-1.5 font-mono text-[11px]" onFocus={(e) => e.target.select()} />
        <IconButton
          title="Copy embed code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              toast.success("Embed code copied");
            } catch {
              toast.error("Couldn't copy; select the code and copy it yourself.");
            }
          }}
        >
          <Copy size={14} />
        </IconButton>
      </div>
      <p className="text-gray-500">Read-only, without the toolbar and side panels. Turning off the link stops the embed too.</p>
    </div>
  );
}
