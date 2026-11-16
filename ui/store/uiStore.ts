import { create } from 'zustand';

interface UIStore {
  productionStage: { number: string; label: string } | null;
  setProductionStage: (stage: { number: string; label: string } | null) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  productionStage: null,
  setProductionStage: (productionStage) => set({ productionStage }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
