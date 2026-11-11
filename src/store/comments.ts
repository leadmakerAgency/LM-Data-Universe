// Cell comments of the open document, with live updates. A thread is a
// top-level comment on a cell (table, row, column) plus its replies.
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Profile } from "@/lib/types";
import { toast } from "./toasts";

export interface DocComment {
  id: string;
  doc_id: string;
  table_ref: string | null;
  row_id: number | null;
  col_id: string | null;
  parent_id: string | null;
  body: string;
  mentions: string[];
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  author: string;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  root: DocComment;
  replies: DocComment[];
}

interface CommentState {
  docId: string | null;
  comments: Map<string, DocComment>;
  /** People who can be @mentioned (members of the document, its workspace and team). */
  people: Map<string, Profile>;
  /** Thread shown in the cell popover. */
  openThread: { tableRef: string; rowId: number; colId: string; anchor: { x: number; y: number } | null } | null;
  load(docId: string): Promise<void>;
  unload(): void;
  add(input: { tableRef: string; rowId: number; colId: string; body: string; mentions: string[]; parentId?: string }): Promise<boolean>;
  setResolved(id: string, resolved: boolean): Promise<void>;
  edit(id: string, body: string, mentions: string[]): Promise<void>;
  remove(id: string): Promise<void>;
  open(t: CommentState["openThread"]): void;
}

let channel: RealtimeChannel | null = null;

export const useComments = create<CommentState>((set, get) => ({
  docId: null,
  comments: new Map(),
  people: new Map(),
  openThread: null,

  async load(docId) {
    get().unload();
    set({ docId });
    const sb = supabase();
    const { data: auth } = await sb.auth.getUser();
    if (!auth.user) return; // comments need an account
    const { data, error } = await sb.from("doc_comments").select("*").eq("doc_id", docId).order("created_at");
    if (error) return;
    if (get().docId !== docId) return;
    set({ comments: new Map((data as DocComment[]).map((c) => [c.id, c])) });
    void loadPeople(docId);
    const ch = sb.channel(`comments-${docId}-${Date.now()}`);
    ch.on("postgres_changes", { event: "*", schema: "public", table: "doc_comments", filter: `doc_id=eq.${docId}` }, (p) => {
      const comments = new Map(get().comments);
      if (p.eventType === "DELETE") comments.delete((p.old as DocComment).id);
      else comments.set((p.new as DocComment).id, p.new as DocComment);
      set({ comments });
    });
    // Deletes can't be filtered by document; unknown ids are ignored.
    ch.on("postgres_changes", { event: "DELETE", schema: "public", table: "doc_comments" }, (p) => {
      const id = (p.old as DocComment).id;
      if (!get().comments.has(id)) return;
      const comments = new Map(get().comments);
      comments.delete(id);
      set({ comments });
    });
    ch.subscribe();
    channel = ch;
  },

  unload() {
    if (channel) void supabase().removeChannel(channel);
    channel = null;
    set({ docId: null, comments: new Map(), openThread: null });
  },

  async add({ tableRef, rowId, colId, body, mentions, parentId }) {
    const docId = get().docId;
    const { data: auth } = await supabase().auth.getUser();
    if (!docId || !auth.user) {
      toast.error("Sign in to comment.");
      return false;
    }
    const row: Record<string, unknown> = parentId
      ? { doc_id: docId, parent_id: parentId, body, mentions, author: auth.user.id }
      : { doc_id: docId, table_ref: tableRef, row_id: rowId, col_id: colId, body, mentions, author: auth.user.id };
    const { data, error } = await supabase().from("doc_comments").insert(row).select().single();
    if (error) {
      toast.error(`Could not add the comment: ${errorMessage(error)}`);
      return false;
    }
    set({ comments: new Map(get().comments).set(data.id, data as DocComment) });
    return true;
  },

  async setResolved(id, resolved) {
    const { data, error } = await supabase().from("doc_comments").update({ resolved }).eq("id", id).select().single();
    if (error) return void toast.error(errorMessage(error));
    set({ comments: new Map(get().comments).set(id, data as DocComment) });
  },

  async edit(id, body, mentions) {
    const { data, error } = await supabase().from("doc_comments").update({ body, mentions }).eq("id", id).select().single();
    if (error) return void toast.error(errorMessage(error));
    set({ comments: new Map(get().comments).set(id, data as DocComment) });
  },

  async remove(id) {
    const { error } = await supabase().from("doc_comments").delete().eq("id", id);
    if (error) return void toast.error(errorMessage(error));
    const comments = new Map(get().comments);
    for (const [k, c] of comments) if (k === id || c.parent_id === id) comments.delete(k);
    set({ comments });
  },

  open(openThread) {
    set({ openThread });
  },
}));

async function loadPeople(docId: string) {
  const sb = supabase();
  const { data: doc } = await sb.from("documents").select("workspace_id").eq("id", docId).maybeSingle();
  const { data: ws } = doc ? await sb.from("workspaces").select("team_id").eq("id", doc.workspace_id).maybeSingle() : { data: null };
  const [dm, wm, tm] = await Promise.all([
    sb.from("document_members").select("user_id").eq("doc_id", docId),
    doc ? sb.from("workspace_members").select("user_id").eq("workspace_id", doc.workspace_id) : Promise.resolve({ data: [] }),
    ws?.team_id ? sb.from("team_members").select("user_id").eq("team_id", ws.team_id) : Promise.resolve({ data: [] }),
  ]);
  const ids = [...new Set([...(dm.data ?? []), ...(wm.data ?? []), ...(tm.data ?? [])].map((r: { user_id: string }) => r.user_id))];
  if (!ids.length) return;
  const { data: profiles } = await sb.from("profiles").select("id,email,full_name").in("id", ids);
  if (useComments.getState().docId !== docId) return;
  useComments.setState({ people: new Map(((profiles ?? []) as Profile[]).map((p) => [p.id, p])) });
}

/** Threads by cell key `${tableRef}:${rowId}:${colId}`, oldest first. */
export function threadsByCell(comments: Map<string, DocComment>): Map<string, Thread[]> {
  const roots = new Map<string, Thread>();
  for (const c of comments.values()) if (!c.parent_id) roots.set(c.id, { root: c, replies: [] });
  for (const c of comments.values()) if (c.parent_id) roots.get(c.parent_id)?.replies.push(c);
  const out = new Map<string, Thread[]>();
  for (const t of roots.values()) {
    t.replies.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const key = `${t.root.table_ref}:${t.root.row_id}:${t.root.col_id}`;
    out.set(key, [...(out.get(key) ?? []), t]);
  }
  for (const list of out.values()) list.sort((a, b) => a.root.created_at.localeCompare(b.root.created_at));
  return out;
}

export function personName(p: Profile | undefined): string {
  return p?.full_name || p?.email || "Someone";
}
