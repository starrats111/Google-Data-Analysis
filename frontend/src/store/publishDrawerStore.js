import { create } from 'zustand'

export const usePublishDrawer = create((set) => ({
  open: false,
  processing: false,
  processingLabel: '',

  openDrawer: () => set({ open: true }),
  closeDrawer: () => set({ open: false }),
  toggleDrawer: () => set((s) => ({ open: !s.open })),
  setProcessing: (processing, processingLabel = '') =>
    set({ processing, processingLabel: processing ? processingLabel : '' }),
}))
