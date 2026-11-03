import { create } from "zustand";

export type PanelState =
  | { tab: "column"; colId: string; focusFormula?: boolean }
  | { tab: "widget"; widgetId: string }
  | null;

interface UiState {
  /** Page id, or "raw" for the Raw data view. */
  activePage: string | null;
  activeWidget: string | null;
  rawTable: string | null;
  panel: PanelState;
  search: string;
  setActivePage(id: string | null): void;
  setActiveWidget(id: string | null): void;
  setRawTable(id: string | null): void;
  openPanel(p: PanelState): void;
  setSearch(s: string): void;
}

export const useUi = create<UiState>((set) => ({
  activePage: null,
  activeWidget: null,
  rawTable: null,
  panel: null,
  search: "",
  setActivePage: (id) => set({ activePage: id, activeWidget: null, search: "" }),
  setActiveWidget: (id) => set({ activeWidget: id }),
  setRawTable: (id) => set({ rawTable: id }),
  openPanel: (panel) => set({ panel }),
  setSearch: (search) => set({ search }),
}));
