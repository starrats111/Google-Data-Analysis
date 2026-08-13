import { DRAFT_STAGES, type DraftStage } from "./types";

/**
 * `completed_stages` 列既可能存 legacy 字符串（旧版 6 阶段写入），
 * 也可能存新的对象记号 `{stage, skipped?}`（filter 模式跳过 discover_sitelink_urls 时使用，
 * spec §4.2 / §7.6）。所有读取路径都需要兼容这两种 shape。
 */
export type CompletedStageEntry = string | { stage: string; skipped?: boolean };

export interface DraftState {
  status: string;
  currentStage: string | null;
  completedStages: CompletedStageEntry[];
  failedStage?: string | null;
}

function entryStageName(entry: CompletedStageEntry): string {
  return typeof entry === "string" ? entry : entry.stage;
}

export function advanceDraftOnce(state: DraftState): DraftState {
  if (state.status !== "draft_generating") return state;
  if (state.failedStage) return state;

  const completed = new Set(state.completedStages.map(entryStageName));
  let nextStage: DraftStage | null = null;

  for (const stage of DRAFT_STAGES) {
    if (!completed.has(stage)) {
      nextStage = stage;
      break;
    }
  }

  if (!nextStage) {
    return { ...state, status: "draft_ready", currentStage: null };
  }

  return { ...state, currentStage: nextStage };
}

export function markDraftStageFailed(
  state: DraftState,
  stage: string,
  _errorMessage: string,
): DraftState {
  void _errorMessage;
  return {
    ...state,
    status: "draft_failed",
    failedStage: stage,
    currentStage: null,
  };
}

export function markDraftStageCompleted(state: DraftState, stage: string): DraftState {
  return advanceDraftOnce({
    ...state,
    completedStages: [...state.completedStages, stage],
  });
}

/**
 * 跳过指定阶段：在 `completed_stages` 写入 `{stage, skipped:true}` 对象记号，
 * 并推进到下一个未完成阶段。filter 模式在 `discover_sitelink_urls` 使用。
 */
export function markDraftStageSkipped(state: DraftState, stage: string): DraftState {
  return advanceDraftOnce({
    ...state,
    completedStages: [...state.completedStages, { stage, skipped: true }],
  });
}
