"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Avatar, Button, IconButton, Input, Modal, Select, Spinner } from "./ui";
import { supabase, errorMessage } from "@/lib/supabase";
import { toast } from "@/store/toasts";
import type { Profile, Role } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  kind: "document" | "workspace";
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

export function ShareDialog({ open, onClose, kind, targetId, title, canManage, currentUserId }: Props) {
  const [members, setMembers] = useState<Row[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);

  const table = kind === "document" ? "document_members" : "workspace_members";
  const key = kind === "document" ? "doc_id" : "workspace_id";

  const load = useCallback(async () => {
    const sb = supabase();
    const { data, error } = await sb.from(table).select("user_id, role").eq(key, targetId);
    if (error) return toast.error(errorMessage(error));
    const rows = data as Row[];
    const ids = rows.map((r) => r.user_id);
    const { data: profiles } = ids.length ? await sb.from("profiles").select("id,email,full_name").in("id", ids) : { data: [] };
    const byId = new Map(((profiles ?? []) as Profile[]).map((p) => [p.id, p]));
    setMembers(rows.map((r) => ({ ...r, profile: byId.get(r.user_id) })));
  }, [table, key, targetId]);

  useEffect(() => {
    // Fetches members; state is set after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void load();
  }, [open, load]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    const { error } =
      kind === "document"
        ? await supabase().rpc("share_document", { p_doc: targetId, p_email: email.trim(), p_role: role })
        : await supabase().rpc("share_workspace", { p_workspace: targetId, p_email: email.trim(), p_role: role });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`Shared with ${email.trim()}`);
    setEmail("");
    void load();
  };

  const changeRole = async (userId: string, email: string, newRole: Role) => {
    const { error } =
      kind === "document"
        ? await supabase().rpc("share_document", { p_doc: targetId, p_email: email, p_role: newRole })
        : await supabase().rpc("share_workspace", { p_workspace: targetId, p_email: email, p_role: newRole });
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  const remove = async (userId: string) => {
    const { error } =
      kind === "document"
        ? await supabase().rpc("remove_document_member", { p_doc: targetId, p_user: userId })
        : await supabase().rpc("remove_workspace_member", { p_workspace: targetId, p_user: userId });
    if (error) return toast.error(errorMessage(error));
    void load();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Share “${title}”`} width={520}>
      {canManage && (
        <form onSubmit={invite} className="mb-4 flex gap-2">
          <Input placeholder="Email of a registered user" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
      <p className="mb-2 text-xs text-gray-500">
        {kind === "workspace"
          ? "Workspace members can open every document in this workspace."
          : "People listed here have direct access. Members of the document's workspace also have access."}
      </p>
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
                  <Select
                    className="h-8 w-28"
                    value={m.role}
                    onChange={(e) => changeRole(m.user_id, m.profile!.email, e.target.value as Role)}
                  >
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
        </ul>
      )}
    </Modal>
  );
}
