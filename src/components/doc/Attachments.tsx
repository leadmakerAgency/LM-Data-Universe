"use client";

import clsx from "clsx";
import { Download, FileText, Maximize2, Paperclip, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton, Modal, Spinner } from "@/components/ui";
import {
  attachmentIds,
  attachmentMeta,
  attachmentMissing,
  attachmentUrl,
  formatBytes,
  isImage,
  uploadAttachment,
  useAttachments,
  type AttachmentMeta,
} from "@/lib/attachments";
import type { DocColumn } from "@/lib/types";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";

function useSignedUrl(m: AttachmentMeta | undefined, enabled = true) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!m || !enabled) return;
    let live = true;
    void attachmentUrl(m).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [m, enabled]);
  return url;
}

function Thumb({ docId, id, size }: { docId: string | null; id: string; size: number }) {
  useAttachments((s) => s.version);
  const m = attachmentMeta(docId, id);
  const image = !!m && isImage(m);
  const url = useSignedUrl(m, image);
  const ext = m?.file_name.split(".").pop()?.slice(0, 4).toUpperCase() ?? "";
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded border border-gray-200 bg-gray-50 text-[9px] font-semibold text-gray-500"
      style={{ width: size, height: size }}
      title={m ? `${m.file_name} (${formatBytes(m.size)})` : attachmentMissing(id) ? "File not found" : "Loading…"}
    >
      {image && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={m!.file_name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        ext || <Paperclip size={size / 2} />
      )}
    </span>
  );
}

/** Thumbnails shown inside a cell or card field. */
export function AttachmentsCell({ value, size = 22 }: { value: unknown; size?: number }) {
  const docId = useDoc((s) => s.docId);
  const ids = attachmentIds(value);
  if (!ids.length) return null;
  const shown = ids.slice(0, 6);
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.map((id) => (
        <Thumb key={id} docId={docId} id={id} size={size} />
      ))}
      {ids.length > shown.length && <span className="text-xs text-gray-500">+{ids.length - shown.length}</span>}
    </span>
  );
}

/** Manage the files in one Attachments cell: upload, preview, download, remove. */
export function AttachmentsDialog({
  col,
  rowId,
  canEdit,
  onClose,
}: {
  col: DocColumn;
  rowId: number;
  canEdit: boolean;
  onClose: () => void;
}) {
  const docId = useDoc((s) => s.docId);
  useDoc((s) => s.version);
  useAttachments((s) => s.version);
  const raw = useDoc.getState().rows.get(col.table_ref)?.get(rowId)?.data[col.id];
  const ids = attachmentIds(raw);
  const editable = canEdit && !col.is_formula;
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(ids[0] ?? null);
  const input = useRef<HTMLInputElement>(null);

  const setIds = (next: string[]) =>
    useDoc.getState().setCells([{ tableRef: col.table_ref, rowId, colId: col.id, value: next.length ? next : null }]);

  const addFiles = async (files: FileList | File[]) => {
    if (!docId || !editable) return;
    const list = [...files];
    if (!list.length) return;
    setUploading((n) => n + list.length);
    const added: string[] = [];
    for (const f of list) {
      try {
        added.push((await uploadAttachment(docId, f)).id);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added.length) {
      // Read the latest value: another upload or a collaborator may have changed it.
      const current = attachmentIds(useDoc.getState().rows.get(col.table_ref)?.get(rowId)?.data[col.id]);
      await setIds([...current, ...added]);
      setPreview(added[0]);
    }
  };

  const remove = (id: string) => {
    void setIds(ids.filter((x) => x !== id));
    if (preview === id) setPreview(null);
  };

  const current = preview && ids.includes(preview) ? preview : ids[0] ?? null;

  return (
    <Modal open onClose={onClose} title={`${col.label || col.col_id} · ${ids.length} file${ids.length === 1 ? "" : "s"}`} width={720}>
      <div
        className={clsx("space-y-3", dragOver && "rounded-lg outline-dashed outline-2 outline-brand-400")}
        onDragOver={(e) => {
          if (!editable) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) void addFiles(e.clipboardData.files);
        }}
      >
        {current && <Preview docId={docId} id={current} />}

        {ids.length > 0 && (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {ids.map((id) => (
              <FileRow key={id} docId={docId} id={id} active={id === current} onSelect={() => setPreview(id)} onRemove={editable ? () => remove(id) : undefined} />
            ))}
          </ul>
        )}

        {editable ? (
          <button
            className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500 hover:border-brand-400 hover:text-brand-700"
            onClick={() => input.current?.click()}
          >
            {uploading ? <Spinner /> : <Upload size={18} />}
            <span>{uploading ? `Uploading ${uploading} file${uploading === 1 ? "" : "s"}…` : "Click, drop or paste files to upload (up to 50 MB each)"}</span>
          </button>
        ) : (
          !ids.length && <p className="py-6 text-center text-sm text-gray-400">No files.</p>
        )}
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </Modal>
  );
}

function Preview({ docId, id }: { docId: string | null; id: string }) {
  const m = attachmentMeta(docId, id);
  const url = useSignedUrl(m);
  if (!m) return null;
  const pdf = m.mime === "application/pdf";
  if (!url) return <div className="flex h-64 items-center justify-center rounded-lg bg-gray-50"><Spinner /></div>;
  if (isImage(m)) {
    return (
      <div className="flex max-h-[45vh] justify-center overflow-hidden rounded-lg bg-gray-50">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={m.file_name} className="max-h-[45vh] object-contain" />
      </div>
    );
  }
  if (pdf) return <iframe src={url} title={m.file_name} className="h-[45vh] w-full rounded-lg border border-gray-200" />;
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-1 rounded-lg bg-gray-50 text-sm text-gray-500">
      <FileText size={28} />
      No preview for this file type
    </div>
  );
}

function FileRow({
  docId,
  id,
  active,
  onSelect,
  onRemove,
}: {
  docId: string | null;
  id: string;
  active: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  const m = attachmentMeta(docId, id);
  const download = async () => {
    if (!m) return;
    const url = await attachmentUrl(m, true);
    if (url) window.open(url, "_blank", "noopener");
    else toast.error("Could not get a download link");
  };
  return (
    <li className={clsx("flex items-center gap-3 px-3 py-2", active && "bg-brand-50/50")}>
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onSelect}>
        <Thumb docId={docId} id={id} size={36} />
        <span className="min-w-0">
          <span className={clsx("block truncate text-sm", !m && attachmentMissing(id) && "text-red-600")}>
            {m?.file_name ?? (attachmentMissing(id) ? "File not found" : "Loading…")}
          </span>
          {m && <span className="text-xs text-gray-500">{formatBytes(m.size)}</span>}
        </span>
      </button>
      <IconButton title="Open: preview, versions, import a spreadsheet into a table" onClick={() => useUi.getState().openFile({ id })} disabled={!m}>
        <Maximize2 size={15} />
      </IconButton>
      <IconButton title="Download" onClick={download} disabled={!m}>
        <Download size={15} />
      </IconButton>
      {onRemove && (
        <IconButton title="Remove from cell" onClick={onRemove}>
          <Trash2 size={15} />
        </IconButton>
      )}
    </li>
  );
}

