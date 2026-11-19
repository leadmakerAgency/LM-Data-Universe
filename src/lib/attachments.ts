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
  created_by?: string | null;
  /** 1 for a first upload; a new version points at the one it replaces. */
  version?: number;
  replaces?: string | null;
  /** What changed in this version. */
  note?: string | null;
  sha256?: string | null;
  /** CSV / Excel files: size of the first sheet and its column names. */
  table_info?: { rows: number; cols: number; headers: string[]; sheets: number } | null;
  /** A small preview image next to the file. */
  thumb_path?: string | null;
}

export type FileKind = "table" | "image" | "pdf" | "text" | "other";

/** What a file is, from its type and name: decides how it is previewed. */
export function fileKind(m: Pick<AttachmentMeta, "mime" | "file_name">): FileKind {
  const ext = m.file_name.split(".").pop()?.toLowerCase() ?? "";
  if (["csv", "tsv", "xlsx", "xlsm", "xls"].includes(ext) || /spreadsheetml|ms-excel|text\/csv|tab-separated/.test(m.mime)) return "table";
  if (isImage(m)) return "image";
  if (ext === "pdf" || m.mime === "application/pdf") return "pdf";
  if (["txt", "md", "json", "xml", "log", "yaml", "yml", "html", "css", "js", "ts", "sql"].includes(ext) || /^text\//.test(m.mime)) return "text";
  return "other";
}

export const KIND_LABEL: Record<FileKind, string> = { table: "Spreadsheet", image: "Image", pdf: "PDF", text: "Text", other: "File" };

async function sha256Hex(file: File): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** A small WebP of an image (longest side 480 px), or null when the browser can't make one. */
async function makeThumb(file: File): Promise<Blob | null> {
  if (!/^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.type) || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", 0.8));
  } catch {
    return null;
  }
}

/** Rows, columns and headers of a CSV / Excel file (files up to 15 MB; larger ones are left unread). */
async function readTableInfo(file: File): Promise<AttachmentMeta["table_info"]> {
  if (fileKind({ mime: file.type, file_name: file.name }) !== "table" || file.size > 15 * 1024 * 1024) return null;
  try {
    const { readFile } = await import("./importer");
    const sheets = await readFile(file);
    const first = sheets[0];
    if (!first) return null;
    return { rows: first.rows.length, cols: first.header.length, headers: first.header.slice(0, 60).map((h) => String(h).slice(0, 80)), sheets: sheets.length };
  } catch {
    return null;
  }
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

/**
 * Uploads a file and records its metadata; returns the new attachment.
 * With `previous`, the upload is a new version of that file.
 */
export async function uploadAttachment(docId: string, file: File, opts: { previous?: AttachmentMeta; note?: string } = {}): Promise<AttachmentMeta> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`“${file.name}” is larger than 50 MB.`);
  const id = crypto.randomUUID();
  const path = `${docId}/${id}/${safeFileName(file.name)}`;
  const mime = file.type || "application/octet-stream";
  const sb = supabase();
  const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw new Error(`Could not upload “${file.name}”: ${errorMessage(up.error)}`);
  // Extras are best effort: a file is never refused because its preview or summary couldn't be made.
  const [sha256, thumb, table_info] = await Promise.all([sha256Hex(file), makeThumb(file), readTableInfo(file)]);
  let thumb_path: string | null = null;
  if (thumb) {
    const p = `${docId}/${id}/thumb.webp`;
    const t = await sb.storage.from(BUCKET).upload(p, thumb, { contentType: "image/webp", upsert: false });
    if (!t.error) thumb_path = p;
  }
  const row: AttachmentMeta = {
    id,
    doc_id: docId,
    file_name: file.name.slice(0, 255) || "file",
    size: file.size,
    mime,
    path,
    version: (opts.previous?.version ?? 0) + 1,
    replaces: opts.previous?.id ?? null,
    note: opts.note?.trim().slice(0, 500) || null,
    sha256,
    table_info,
    thumb_path,
  };
  let { error } = await sb.from("doc_attachments").insert(row);
  if (error && /column|schema cache/i.test(error.message)) {
    // A database without the version columns yet: keep uploads working.
    ({ error } = await sb.from("doc_attachments").insert({ id, doc_id: docId, file_name: row.file_name, size: row.size, mime, path }));
  }
  if (error) {
    await sb.storage.from(BUCKET).remove(thumb_path ? [path, thumb_path] : [path]);
    throw new Error(`Could not save “${file.name}”: ${errorMessage(error)}`);
  }
  row.created_at = new Date().toISOString();
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

/** A signed URL for a file's small preview image; the image itself when it has none. */
export async function attachmentThumbUrl(m: AttachmentMeta): Promise<string | null> {
  if (m.thumb_path) {
    const key = `${m.thumb_path}|thumb`;
    const hit = urls.get(key);
    if (hit && hit.expires > Date.now() + 60_000) return hit.url;
    const { data } = await supabase().storage.from(BUCKET).createSignedUrl(m.thumb_path, 3600);
    if (data?.signedUrl) {
      urls.set(key, { url: data.signedUrl, expires: Date.now() + 3600_000, download: false });
      return data.signedUrl;
    }
  }
  return isImage(m) ? attachmentUrl(m) : null;
}

/** A file's bytes (for previews and imports). */
export async function attachmentBytes(m: AttachmentMeta): Promise<ArrayBuffer> {
  const { data, error } = await supabase().storage.from(BUCKET).download(m.path);
  if (error || !data) throw new Error(`Could not open “${m.file_name}”`);
  return data.arrayBuffer();
}

/** Earlier versions of a file, newest first (the file itself is not included). */
export async function attachmentHistory(m: AttachmentMeta): Promise<AttachmentMeta[]> {
  const out: AttachmentMeta[] = [];
  let prev = m.replaces ?? null;
  for (let i = 0; prev && i < 50; i++) {
    const { data } = await supabase().from("doc_attachments").select("*").eq("id", prev).maybeSingle();
    if (!data) break;
    out.push(data as AttachmentMeta);
    prev = (data as AttachmentMeta).replaces ?? null;
  }
  remember(out);
  return out;
}

/** Another file in the document with exactly the same content, if any. */
export async function sameContent(m: AttachmentMeta): Promise<AttachmentMeta | null> {
  if (!m.sha256) return null;
  const { data } = await supabase().from("doc_attachments").select("*").eq("doc_id", m.doc_id).eq("sha256", m.sha256).neq("id", m.id).limit(1);
  return ((data ?? [])[0] as AttachmentMeta | undefined) ?? null;
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
