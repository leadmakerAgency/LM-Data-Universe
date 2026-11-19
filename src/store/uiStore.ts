import { create } from "zustand";
import type { ColumnFilter, SortSpec } from "@/lib/types";
import type { AttachmentMeta } from "@/lib/attachments";
import type { ImportMode, Sheet } from "@/lib/importer";

/** A file opened in the viewer; `siblings` are the files next / previous steps through. */
export interface FileView {
  id: string;
  siblings?: string[];
  /** The cell holding the file, when it was opened from one (needed to add a new version). */
  cell?: { tableRef: string; rowId: number; colId: string };
}

/** An import started from an attached file (optionally repeating an earlier import's mapping). */
export interface ImportSource {
  sheets: Sheet[];
  label: string;
  attachment?: AttachmentMeta;
  preset?: { tableRef: string; mapping: { header: string; col: string }[]; keys: string[]; mode: ImportMode };
}

export type PanelState =
  | { tab: "column"; colId: string; focusFormula?: boolean }
  | { tab: "widget"; widgetId: string }
  | { tab: "formulas" }
  | { tab: "comments" }
  | { tab: "history" }
  | null;

/** Sort and filter changes not saved to the widget yet (Grist-style Save / Revert). */
export interface WidgetDraft {
  sort?: SortSpec[];
  filters?: Record<string, ColumnFilter>;
}

/** The cell "Find" last moved to. `seq` changes on every move so widgets react to repeats. */
export interface FindTarget {
  widgetId: string;
  rowId: number;
  colId: string;
  seq: number;
}

interface UiState {
  /** Page id, or "raw" for the Raw data view. */
  activePage: string | null;
  activeWidget: string | null;
  rawTable: string | null;
  panel: PanelState;
  search: string;
  drafts: Record<string, WidgetDraft>;
  findTarget: FindTarget | null;
  /** Record shown in the record card popup. */
  recordCard: { tableRef: string; rowId: number } | null;
  fileView: FileView | null;
  importSource: ImportSource | null;
  /** Shown inside another site (embed code): no editing chrome. */
  embed: boolean;
  setActivePage(id: string | null): void;
  setActiveWidget(id: string | null): void;
  setRawTable(id: string | null): void;
  openPanel(p: PanelState): void;
  setSearch(s: string): void;
  setDraft(widgetId: string, d: WidgetDraft | null): void;
  setFindTarget(t: Omit<FindTarget, "seq"> | null): void;
  openRecordCard(c: { tableRef: string; rowId: number } | null): void;
  openFile(f: FileView | null): void;
  importFrom(s: ImportSource | null): void;
}

let seq = 0;

export const useUi = create<UiState>((set) => ({
  activePage: null,
  activeWidget: null,
  rawTable: null,
  panel: null,
  search: "",
  drafts: {},
  findTarget: null,
  recordCard: null,
  fileView: null,
  importSource: null,
  embed: false,
  setActivePage: (id) => set({ activePage: id, activeWidget: null, search: "", findTarget: null }),
  setActiveWidget: (id) => set({ activeWidget: id }),
  setRawTable: (id) => set({ rawTable: id }),
  openPanel: (panel) => set({ panel }),
  setSearch: (search) => set({ search, findTarget: null }),
  setDraft: (widgetId, d) =>
    set((s) => {
      const drafts = { ...s.drafts };
      if (d && Object.keys(d).length) drafts[widgetId] = d;
      else delete drafts[widgetId];
      return { drafts };
    }),
  setFindTarget: (t) => set({ findTarget: t ? { ...t, seq: ++seq } : null }),
  openRecordCard: (recordCard) => set({ recordCard }),
  openFile: (fileView) => set({ fileView }),
  importFrom: (importSource) => set({ importSource }),
}));

/** A widget with its unsaved sort / filter applied. */
export function withDraft<W extends { id: string; options: object }>(w: W, draft: WidgetDraft | undefined): W {
  return draft ? { ...w, options: { ...w.options, ...draft } } : w;
}
