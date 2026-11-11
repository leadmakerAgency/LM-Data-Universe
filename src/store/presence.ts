// Who else has the document open, and which cell each person is on, through
// a Supabase Realtime Presence channel per document. Nothing is stored.
import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export interface Peer {
  key: string;
  userId: string | null;
  name: string;
  color: string;
  widgetId?: string | null;
  rowId?: number | null;
  colId?: string | null;
}

const COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777", "#0d9488", "#9333ea"];

export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

interface PresenceState {
  peers: Peer[];
  me: string | null;
}

export const usePresence = create<PresenceState>(() => ({ peers: [], me: null }));

let channel: RealtimeChannel | null = null;
let self: Omit<Peer, "key"> | null = null;
let selfKey = "";
let timer: ReturnType<typeof setTimeout> | null = null;

export function joinPresence(docId: string, who: { userId: string | null; name: string }) {
  leavePresence();
  // One key per browser tab, so the same person in two tabs shows twice.
  selfKey = `${who.userId ?? "guest"}:${Math.random().toString(36).slice(2, 8)}`;
  self = { userId: who.userId, name: who.name || "Guest", color: colorFor(who.userId ?? selfKey) };
  usePresence.setState({ me: selfKey, peers: [] });
  const ch = supabase().channel(`presence-doc-${docId}`, { config: { presence: { key: selfKey } } });
  ch.on("presence", { event: "sync" }, () => {
    const state = ch.presenceState<Omit<Peer, "key">>();
    const peers: Peer[] = [];
    for (const [key, metas] of Object.entries(state)) {
      if (key === selfKey) continue;
      const m = metas[metas.length - 1];
      if (m) peers.push({ key, userId: m.userId ?? null, name: m.name ?? "Guest", color: m.color ?? colorFor(key), widgetId: m.widgetId, rowId: m.rowId, colId: m.colId });
    }
    usePresence.setState({ peers });
  });
  ch.subscribe((status) => {
    if (status === "SUBSCRIBED" && self) void ch.track(self);
  });
  channel = ch;
}

export function leavePresence() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (channel) {
    void channel.untrack();
    void supabase().removeChannel(channel);
    channel = null;
  }
  usePresence.setState({ peers: [], me: null });
}

/** Shares the cell this tab is on (throttled). */
export function updateCursor(c: { widgetId: string | null; rowId: number | null; colId: string | null }) {
  if (!self) return;
  self = { ...self, ...c };
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (channel && self) void channel.track(self);
  }, 150);
}
