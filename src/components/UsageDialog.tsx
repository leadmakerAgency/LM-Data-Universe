"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { Button, Modal, Spinner } from "./ui";
import { errorMessage, supabase } from "@/lib/supabase";

export interface Plan {
  id: string;
  name: string;
  max_docs: number | null;
  max_rows_per_doc: number | null;
  max_attachment_mb: number | null;
}

interface UsageInfo {
  plan: Plan | null;
  usage: { docs: number; rows: number; largest_doc_rows: number; attachment_bytes: number; actions_30d: number };
  api_calls_30d: number | null;
}

export const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

export function Meter({ label, used, max, format = (n: number) => n.toLocaleString() }: { label: string; used: number; max: number | null; format?: (n: number) => string }) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-600">
          {format(used)} {max ? `of ${format(max)}` : <span className="text-gray-400">· no limit</span>}
        </span>
      </div>
      {max ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-100" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
          <div className={clsx("h-full rounded-full", pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Plan, limits and usage of the person's own account or of a team. */
export function UsageDialog({ team, onClose }: { team?: { id: string; name: string } | null; onClose: () => void }) {
  const [info, setInfo] = useState<UsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const teamId = team?.id ?? null;

  useEffect(() => {
    let live = true;
    void supabase()
      .rpc("my_usage", { p_team: teamId })
      .then(({ data, error }) => {
        if (!live) return;
        if (error) setError(errorMessage(error));
        else setInfo(data as UsageInfo);
      });
    return () => {
      live = false;
    };
  }, [teamId]);

  const p = info?.plan;
  return (
    <Modal open onClose={onClose} title={team ? `Plan and usage · ${team.name}` : "Plan and usage"} width={520} footer={<Button onClick={onClose}>Close</Button>}>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !info ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {team ? "This team's" : "Your own workspaces'"} plan: <strong className="text-gray-900">{p?.name ?? "Free"}</strong>.{" "}
            {team ? "Documents in the team's workspaces count here." : "Documents in teams count towards the team instead."} Documents in the trash
            don&apos;t count. An administrator can change the plan.
          </p>
          <Meter label="Documents" used={info.usage.docs} max={p?.max_docs ?? null} />
          <Meter label="Records in the largest document" used={info.usage.largest_doc_rows} max={p?.max_rows_per_doc ?? null} />
          <Meter
            label="Attachment storage"
            used={info.usage.attachment_bytes}
            max={p?.max_attachment_mb ? p.max_attachment_mb * 1024 * 1024 : null}
            format={formatBytes}
          />
          <dl className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 text-sm">
            <div>
              <dt className="text-xs text-gray-500">Records in all documents</dt>
              <dd className="tabular-nums">{Number(info.usage.rows).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Changes, last 30 days</dt>
              <dd className="tabular-nums">{Number(info.usage.actions_30d).toLocaleString()}</dd>
            </div>
            {info.api_calls_30d !== null && (
              <div>
                <dt className="text-xs text-gray-500">API calls, last 30 days</dt>
                <dd className="tabular-nums">{Number(info.api_calls_30d).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </Modal>
  );
}
