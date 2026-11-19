"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Input, Label, Modal, Select } from "./ui";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Workspace } from "@/lib/types";
import { toast } from "@/store/toasts";

/**
 * "Save a copy" (with or without the data) and
 * "Work on a copy" (a copy that can later replace the original).
 */
export function CopyDialog({
  docId,
  docName,
  defaultWorkspace,
  fork,
  onClose,
}: {
  docId: string;
  docName: string;
  defaultWorkspace?: string;
  fork?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(fork ? `${docName} (working copy)` : `${docName} (copy)`);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ws, setWs] = useState(defaultWorkspace ?? "");
  const [withData, setWithData] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const sb = supabase();
      const [{ data: list }, { data: editable }] = await Promise.all([
        sb.from("workspaces").select("*").order("created_at"),
        sb.rpc("my_workspace_ids", { p_min: 2 }),
      ]);
      const ok = new Set((editable ?? []) as string[]);
      const usable = ((list ?? []) as Workspace[]).filter((w) => ok.has(w.id)).sort((a, b) => Number(b.is_personal) - Number(a.is_personal));
      setWorkspaces(usable);
      setWs((cur) => (cur && usable.some((w) => w.id === cur) ? cur : (usable[0]?.id ?? "")));
    })();
  }, []);

  const submit = async () => {
    if (!ws) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("copy_document", {
      p_doc: docId,
      p_workspace: ws,
      p_name: name,
      p_with_data: fork ? true : withData,
      p_fork: !!fork,
    });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(fork ? "Working copy created. Replace the original from its banner when you're done." : "Copy created");
    onClose();
    router.push(`/doc/${data}`);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={fork ? "Work on a copy" : "Save a copy"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !ws || !name.trim()}>
            {busy ? "Copying…" : fork ? "Create working copy" : "Save copy"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {fork && (
          <p className="text-gray-600">
            Make changes in a separate copy without affecting “{docName}”. When you&apos;re happy, compare it with the original and replace the
            original in one step (owners only; a snapshot of the original is kept).
          </p>
        )}
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Workspace</Label>
          <Select value={ws} onChange={(e) => setWs(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        {!fork && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!withData} onChange={(e) => setWithData(!e.target.checked)} />
            Structure only (tables, columns, formulas, pages and widgets, without the records), to start a similar document
          </label>
        )}
        <p className="text-xs text-gray-400">Attached files aren&apos;t copied; attachment cells in the copy start empty.</p>
      </div>
    </Modal>
  );
}
