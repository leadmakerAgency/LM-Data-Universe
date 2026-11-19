"use client";

// /w/<workspace>[/<section>|/clients/<id>]: the workspace with its permanent
// sections. Opens (and the first time sets up) the workspace's hub document
// and shows its pages as Overview, Clients, Pipeline, Planning, Files & assets.
import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button, Input, Label, Modal, Select } from "@/components/ui";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { customSectionColumns, hubConfig, openHub, saveHubConfig, sectionKey, type HubConfig, type SectionIcon } from "@/lib/hub";
import { useRequireSession } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Team, WidgetType, Workspace } from "@/lib/types";
import { useComments } from "@/store/comments";
import { useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";
import { useUi } from "@/store/uiStore";
import { CellCommentsPopover } from "../doc/Comments";
import { FileViewerModal } from "../doc/FileViewer";
import { ImportDialog } from "../doc/ImportDialog";
import { RecordCardModal } from "../doc/RecordCard";
import { RightPanel } from "../doc/RightPanel";
import { ClientPage } from "./ClientPage";
import { HubSidebar } from "./HubSidebar";
import { Overview } from "./Overview";
import { SectionView } from "./SectionView";

const PURPOSES: { type: WidgetType; label: string; icon: SectionIcon }[] = [
  { type: "board", label: "Stages on a board (requests, campaigns, hiring)", icon: "kanban" },
  { type: "timeline", label: "A plan over time (launches, schedules)", icon: "gantt" },
  { type: "gallery", label: "A library of files or images", icon: "images" },
  { type: "calendar", label: "A calendar (events, posts, meetings)", icon: "calendar" },
  { type: "table", label: "A list (invoices, inventory, anything)", icon: "list" },
];

function AddSectionDialog({ config, docId, onDone }: { config: HubConfig; docId: string; onDone: (c: HubConfig | null, key?: string) => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState<WidgetType>("board");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const label = name.trim();
    if (!label) return;
    setBusy(true);
    try {
      const store = useDoc.getState();
      const specs = customSectionColumns(purpose);
      const table = await store.addTable(label, specs.map((c) => ({ label: c.label, type: c.type })));
      if (!table) throw new Error("Couldn't create the table");
      const { tableColumns } = await import("@/store/docStore");
      for (const spec of specs) {
        const col = tableColumns(table.id).find((c) => c.label === spec.label);
        if (col && spec.options) await store.updateColumn(col.id, { options: spec.options }, { undoable: false });
      }
      const clientsCols = tableColumns(config.clients);
      await store.addColumn(table.id, { label: "Client", type: "Ref", options: { refTable: config.clients, visibleCol: clientsCols[0]?.id ?? null } }, 1.5);
      const page = await store.addPage(label, { type: purpose, tableRef: table.id, title: "All", width: 12 });
      if (!page) throw new Error("Couldn't create the section's page");
      const w = [...useDoc.getState().widgets.values()].find((x) => x.page_id === page.id);
      if (w) await store.updateWidget(w.id, { height: 600 });
      const key = sectionKey(label, config.sections.map((s) => s.key));
      const next: HubConfig = {
        ...config,
        sections: [...config.sections, { key, label, icon: PURPOSES.find((p) => p.type === purpose)!.icon, page: page.id, table: table.id, noun: label.replace(/s$/i, "") || "Record" }],
      };
      await saveHubConfig(docId, next);
      onDone(next, key);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={() => onDone(null)}
      title="Add a section"
      footer={
        <>
          <Button onClick={() => onDone(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Add section"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Campaigns, Invoices, Requests" onKeyDown={(e) => e.key === "Enter" && void create()} />
        </div>
        <div>
          <Label>What it is for</Label>
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value as WidgetType)}>
            {PURPOSES.map((p) => (
              <option key={p.type} value={p.type}>
                {p.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-gray-500">It gets its own table linked to Clients, so it works with the client filter. You can switch views and add columns later.</p>
        </div>
      </div>
    </Modal>
  );
}

export function WorkspaceScreen({ wsId, path }: { wsId: string; path: string[] }) {
  const session = useRequireSession();
  const router = useRouter();
  const params = useSearchParams();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [hub, setHub] = useState<{ id: string; config: HubConfig | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const docId = useDoc((s) => s.docId);
  const loading = useDoc((s) => s.loading);
  const loadError = useDoc((s) => s.error);
  const role = useDoc((s) => s.role);
  const liveConfig = useDoc((s) => hubConfig(s.doc?.hub_config));
  const recordCard = useUi((s) => s.recordCard);
  const importSource = useUi((s) => s.importSource);
  const config = liveConfig ?? hub?.config ?? null;
  const canEdit = role === "owner" || role === "editor";

  const client = Number(params.get("client")) || null;
  const viewParam = params.get("view");
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null) next.delete(key);
      else next.set(key, value);
      const qs = next.toString();
      router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router],
  );

  useEffect(() => {
    if (!session) return;
    void Promise.all([supabase().from("workspaces").select("*").order("created_at"), supabase().from("teams").select("*").order("name")]).then(([w, t]) => {
      setWorkspaces((w.data as Workspace[] | null) ?? []);
      setTeams((t.data as Team[] | null) ?? []);
    });
  }, [session]);

  const open = useCallback(async () => {
    setError(null);
    try {
      setHub(await openHub(wsId));
      try {
        window.localStorage.setItem("lmdu-last-ws", wsId);
      } catch {
        /* not remembered */
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [wsId]);

  useEffect(() => {
    if (!session) return;
    const t = setTimeout(() => void open(), 0);
    return () => clearTimeout(t);
  }, [session, open]);

  useEffect(() => {
    if (!hub?.id) return;
    void useDoc.getState().load(hub.id);
    void useComments.getState().load(hub.id);
    return () => {
      useDoc.getState().unload();
      useComments.getState().unload();
      useUi.getState().openPanel(null);
    };
  }, [hub?.id]);

  // A client opened anywhere (a reference, a card) goes to the client's page.
  useEffect(() => {
    if (config && recordCard && recordCard.tableRef === config.clients) {
      useUi.getState().openRecordCard(null);
      router.push(`/w/${wsId}/clients/${recordCard.rowId}`);
    }
  }, [recordCard, config, router, wsId]);

  if (!session) return null;
  const ws = workspaces.find((w) => w.id === wsId);
  const [first, second] = path;
  const active = !first ? "overview" : first === "clients" && second ? "client" : first;
  const section = config?.sections.find((s) => s.key === first);

  let body: React.ReactNode;
  if (error) body = <div className="m-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  else if (!hub || loading || docId !== hub.id) {
    body = (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> {hub && !hub.config ? "Setting up this workspace…" : "Loading…"}
      </div>
    );
  } else if (loadError) body = <div className="m-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{loadError}</div>;
  else if (!config) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-600">
        <p>This workspace is still being set up by someone else.</p>
        <Button onClick={() => void open()}>Try again</Button>
      </div>
    );
  } else if (active === "client") body = <ClientPage key={second} wsId={wsId} config={config} rowId={Number(second)} />;
  else if (active === "overview") body = <Overview wsId={wsId} config={config} client={client} workspaceName={ws?.name ?? "Workspace"} />;
  else if (section)
    body = (
      <SectionView
        key={section.key}
        section={section}
        config={config}
        client={client}
        setClient={(id) => setParam("client", id === null ? null : String(id))}
        viewParam={viewParam}
        setViewParam={(id) => setParam("view", id)}
      />
    );
  else body = <div className="p-8 text-sm text-gray-500">This section doesn&apos;t exist.</div>;

  return (
    <div className="flex h-full bg-gray-50">
      <HubSidebar workspaces={workspaces} teams={teams} wsId={wsId} sections={config?.sections ?? []} active={active} client={client} canEdit={canEdit && !!config} onAddSection={() => setAdding(true)} />
      <main className="min-w-0 flex-1">
        <ErrorBoundary label="This page couldn't be displayed">{body}</ErrorBoundary>
      </main>
      {config && docId === hub?.id && (
        <ErrorBoundary label="Settings panel couldn't be displayed">
          <RightPanel />
        </ErrorBoundary>
      )}
      {config && docId === hub?.id && (
        <>
          <RecordCardModal />
          <FileViewerModal />
          <CellCommentsPopover />
          {importSource && <ImportDialog key={importSource.label + (importSource.attachment?.id ?? "")} source={importSource} onClose={() => useUi.getState().importFrom(null)} />}
        </>
      )}
      {adding && config && hub && (
        <AddSectionDialog
          config={config}
          docId={hub.id}
          onDone={(next, key) => {
            setAdding(false);
            if (next) {
              setHub({ ...hub, config: next });
              void useDoc.getState().load(hub.id);
              if (key) router.push(`/w/${wsId}/${key}`);
            }
          }}
        />
      )}
    </div>
  );
}
