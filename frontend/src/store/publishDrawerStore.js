import { create } from 'zustand'

export const usePublishDrawer = create((set, get) => ({
  open: false,
  processing: false,
  processingLabel: '',

  // CR-050: 抽屉模式 — 'collapsed' | 'half' | 'full'
  drawerMode: 'half',
  // 是否有已完成但未查看的任务
  doneNotified: false,
  // 任务是否已启动过（用于显示右侧窄条）
  hasTask: false,

  openDrawer: () => set({ open: true, drawerMode: get().drawerMode || 'half' }),
  closeDrawer: () => set({ open: false }),
  toggleDrawer: () => set((s) => ({ open: !s.open })),

  // 切换半屏/全屏
  setDrawerMode: (mode) => set({ drawerMode: mode }),
  toggleFullscreen: () => set((s) => ({
    drawerMode: s.drawerMode === 'full' ? 'half' : 'full',
  })),

  setProcessing: (processing, processingLabel = '') => {
    const prev = get()
    const updates = {
      processing,
      processingLabel: processing ? processingLabel : '',
    }
    if (processing) {
      updates.hasTask = true
      updates.doneNotified = false
    }
    // 从 processing -> done：标记通知
    if (!processing && prev.processing) {
      updates.doneNotified = true
    }
    set(updates)
  },

  // 清除完成通知
  clearDoneNotify: () => set({ doneNotified: false }),
  // 重置任务状态
  resetTask: () => set({ hasTask: false, doneNotified: false, processing: false, processingLabel: '' }),
}))
