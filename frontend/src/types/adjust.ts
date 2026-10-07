/** 调节单：由失衡度排序生成，执行与复核分两步回写状态 */
export type AdjustState = '待下发' | '已调节' | '已复核'

/**
 * 一次读数快照（执行基准 / 复核复测共用）。
 * 执行时把当时的开度与最新实测固化为基准；复核时只认执行时间之后的新测次并固化为复测。
 */
export interface AdjustReadingSnapshot {
  /** 快照落定时间（执行时间 / 复核时间，毫秒） */
  capturedAt: number
  /** 落定快照时阀门的开度（%） */
  opening: number
  /** 读数来源实测 id，无可用测次时为 null */
  measureId: string | null
  /** 读数日期 YYYY-MM-DD，无测次时为 null */
  date: string | null
  flowM3h: number | null
  supplyTempC: number | null
  returnTempC: number | null
  roomTempC: number | null
  operator: string | null
  /** 按当时读数与设计流量算出的流量比 */
  ratio: number
  /** 按当时读数算出的合成失衡度（%），无测次时为 null */
  imbalanceValue: number | null
  /** 判级，无测次时为 null */
  level: '平衡' | '偏大' | '偏小' | '严重失衡' | null
}

export interface Adjust {
  id: string
  valveId: string
  /** 目标开度（%） */
  targetOpening: number
  /** 调节依据 */
  basis: string
  executor: string
  state: AdjustState
  /** 复核意见 */
  reviewNote: string
  /** 执行时间（状态流转到「已调节」的时刻）；仅在该时刻之后录入的实测才可作复测 */
  executedAt: number | null
  /** 执行时快照：开度与当时最新实测，作为复核基准口径 */
  executionSnapshot: AdjustReadingSnapshot | null
  /** 复核时快照：执行时间之后的最新实测，作为复测口径 */
  reviewSnapshot: AdjustReadingSnapshot | null
  createdAt: number
  updatedAt: number
}

export const ADJUST_STATES: AdjustState[] = ['待下发', '已调节', '已复核']

/** 调节单状态机：待下发 → 已调节 → 已复核 */
export const ADJUST_STATE_FLOW: Record<AdjustState, AdjustState | null> = {
  待下发: '已调节',
  已调节: '已复核',
  已复核: null
}

export interface AdjustDraft {
  valveId: string
  targetOpening: number
  basis: string
  executor: string
  state: AdjustState
  reviewNote: string
}

export const EMPTY_ADJUST_DRAFT: AdjustDraft = {
  valveId: '',
  targetOpening: 50,
  basis: '',
  executor: '',
  state: '待下发',
  reviewNote: ''
}
