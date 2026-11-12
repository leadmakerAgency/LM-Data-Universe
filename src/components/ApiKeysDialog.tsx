"use client";

import { Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, useDialogs } from "./ui";
import { errorMessage, supabase } from "@/lib/supabase";
import { toast } from "@/store/toasts";

interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");

/** Create and revoke personal API keys. A new key is shown once. */
export function ApiKeysDialog({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm } = useDialogs();

  const load = useCallback(async () => {
    const { data, error } = await supabase()
      .from("api_keys")
      .select("id,label,prefix,created_at,last_used_at,revoked_at")
      .order("created_at", { ascending: false });
    if (error) toast.error(errorMessage(error));
    else setKeys(data as ApiKey[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const create = async () => {
    setBusy(true);
    const { data, error } = await supabase().rpc("create_api_key", { p_label: label.trim() });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    setFresh((data as { key: string }).key);
    setLabel("");
    void load();
  };

  const active = (keys ?? []).filter((k) => !k.revoked_at);
  const revoked = (keys ?? []).filter((k) => k.revoked_at);

  return (
    <Modal open onClose={onClose} title="API keys" width={620}>
      <p className="text-sm text-gray-600">
        Keys let n8n, Zapier, Make or your own scripts use the REST API as you: they can do whatever you can in your documents. Keep them secret, and revoke a key
        you no longer use.
      </p>

      {fresh && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-sm font-medium text-emerald-900">Your new key: copy it now, it won&apos;t be shown again.</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-xs">{fresh}</code>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(fresh);
                  toast.success("Key copied");
                } catch {
                  toast.info(fresh);
                }
              }}
            >
              <Copy size={12} /> Copy
            </Button>
          </div>
        </div>
      )}

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) void create();
        }}
      >
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name, e.g. n8n" maxLength={80} />
        <Button variant="primary" disabled={busy || !label.trim()}>
          <KeyRound size={13} /> Create key
        </Button>
      </form>

      <div className="mt-5">
        {keys === null ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : active.length === 0 ? (
          <p className="text-sm text-gray-500">No active keys.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {active.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{k.label}</div>
                  <div className="text-xs text-gray-500">
                    <code>{k.prefix}…</code> · created {day(k.created_at)} · last used {day(k.last_used_at)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Revoke “${k.label}”?`,
                      message: "Anything using this key stops working right away. This can't be undone.",
                      confirmLabel: "Revoke",
                      danger: true,
                    });
                    if (!ok) return;
                    const { error } = await supabase().rpc("revoke_api_key", { p_id: k.id });
                    if (error) toast.error(errorMessage(error));
                    void load();
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 && <p className="mt-2 text-xs text-gray-400">{revoked.length} revoked</p>}
      </div>

      <p className="mt-4 text-xs text-gray-500">
        Send the key as <code className="rounded bg-gray-100 px-1">Authorization: Bearer lmdu_…</code>. Each document&apos;s API address and examples are under
        Integrations in the document.
      </p>
    </Modal>
  );
}
