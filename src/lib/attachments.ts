// Attachments: files live in the private "attachments" Storage bucket under
// {doc_id}/{attachment id}/{file name}; doc_attachments holds their metadata and
// an Attachments cell stores a list of attachment ids. Files stay in storage
// when removed from a cell, so undo can bring them back.
import { create } from "zustand";
import { errorMessage, supabase } from "./supabase";

export interface AttachmentMeta {
  id: string;
  doc_id: string;
  file_name: string;
  size: number;
  mime: string;
  path: string;
  created_at?: string;
}

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const BUCKET = "attachments";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAttachmentId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Attachment ids in a cell value (anything else is ignored). */
export function attachmentIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isAttachmentId) : [];
}

interface AttachmentState {
  meta: Map<string, AttachmentMeta>;
  /** Bumped whenever metadata arrives, so cells re-render. */
  version: number;
}

export const useAttachments = create<AttachmentState>(() => ({ meta: new Map(), version: 0 }));

const requested = new Set<string>();
const missing = new Set<string>();

/** True once a lookup found no file for this id (deleted, or from another document). */
export const attachmentMissing = (id: string) => missing.has(id);
let queue: { docId: string; ids: Set<string> } | null = null;

/** Metadata for an id, if loaded; schedules a fetch otherwise. */
export function attachmentMeta(docId: string | null, id: string): AttachmentMeta | undefined {
  const m = useAttachments.getState().meta.get(id);
  if (m || !docId || requested.has(id)) return m;
  requested.add(id);
  if (!queue || queue.docId !== docId) {
    queue = { docId, ids: new Set() };
    const q = queue;
    // Batch every id requested during this render pass into one query.
    setTimeout(() => {
      if (queue === q) queue = null;
      void fetchMeta(q.docId, [...q.ids]);
    }, 0);
  }
  queue.ids.add(id);
  return undefined;
}

async function fetchMeta(docId: string, ids: string[]) {
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase().from("doc_attachments").select("*").eq("doc_id", docId).in("id", chunk);
    if (error) {
      chunk.forEach((id) => requested.delete(id));
      continue;
    }
    const found = new Set((data as AttachmentMeta[]).map((m) => m.id));
    chunk.forEach((id) => !found.has(id) && missing.add(id));
    remember(data as AttachmentMeta[]);
    if (found.size < chunk.length) useAttachments.setState((s) => ({ version: s.version + 1 }));
  }
}

function remember(list: AttachmentMeta[]) {
  if (!list.length) return;
  useAttachments.setState((s) => {
    const meta = new Map(s.meta);
    for (const m of list) meta.set(m.id, m);
    return { meta, version: s.version + 1 };
  });
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, "_").replace(/[^\w.\- ()]+/g, "_").trim();
  return (cleaned || "file").slice(0, 200);
}

/** Uploads a file and records its metadata; returns the new attachment. */
export async function uploadAttachment(docId: string, file: File): Promise<AttachmentMeta> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`“${file.name}” is larger than 50 MB.`);
  const id = crypto.randomUUID();
  const path = `${docId}/${id}/${safeFileName(file.name)}`;
  const mime = file.type || "application/octet-stream";
  const sb = supabase();
  const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw new Error(`Could not upload “${file.name}”: ${errorMessage(up.error)}`);
  const row = { id, doc_id: docId, file_name: file.name.slice(0, 255) || "file", size: file.size, mime, path };
  const { error } = await sb.from("doc_attachments").insert(row);
  if (error) {
    await sb.storage.from(BUCKET).remove([path]);
    throw new Error(`Could not save “${file.name}”: ${errorMessage(error)}`);
  }
  remember([row]);
  return row;
}

const urls = new Map<string, { url: string; expires: number; download: boolean }>();
const pendingUrls = new Map<string, Promise<string | null>>();

/** A short-lived signed URL for viewing (or downloading) a file. */
export async function attachmentUrl(m: AttachmentMeta, download = false): Promise<string | null> {
  const key = `${m.path}|${download}`;
  const hit = urls.get(key);
  if (hit && hit.expires > Date.now() + 60_000) return hit.url;
  const inflight = pendingUrls.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const { data, error } = await supabase()
      .storage.from(BUCKET)
      .createSignedUrl(m.path, 3600, download ? { download: m.file_name } : undefined);
    pendingUrls.delete(key);
    if (error || !data) return null;
    urls.set(key, { url: data.signedUrl, expires: Date.now() + 3600_000, download });
    return data.signedUrl;
  })();
  pendingUrls.set(key, p);
  return p;
}

export const isImage = (m: Pick<AttachmentMeta, "mime">) => /^image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp)$/i.test(m.mime);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Text for an Attachments value: file names when known. */
export function attachmentsText(docId: string | null, value: unknown): string {
  const ids = attachmentIds(value);
  return ids.map((id) => attachmentMeta(docId, id)?.file_name ?? (missing.has(id) ? "missing file" : "file")).join(", ");
}
