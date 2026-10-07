/** 调节单：由失衡度排序生成，执行与复核分两步回写状态 */
import type { BalanceLevel } from '@/utils/balance'

export type AdjustState = '待下发' | '已调节' | '已复核'

/**
 * 口径读数快照：执行时基准与执行后复测共用同一结构。
 * 数值在取值当下固化，之后阀门参数、实测再改动都不影响已闭环的单据。
 */
export interface AdjustReadingSnapshot {
  /** 读数绑定的实测日期（YYYY-MM-DD）；复测口径只允许执行日期之后的新测次 */
  measureDate: string
  /** 该口径下的阀门开度（%）：执行基准为执行开度，复测为复测时开度 */
  opening: number
  /** 当时实测流量（m³/h） */
  flowM3h: number
  /** 当时室温（℃） */
  roomTempC: number
  /** 快照时的设计流量（m³/h），固化避免阀门后续改参污染旧单 */
  designFlowM3h: number
  /** 流量比 = 实测 ÷ 设计 */
  ratio: number
  /** 流量偏差率（%），正值偏大 */
  flowDeviation: number
  /** 室温偏差（℃） */
  roomDeviation: number
  /** 合成失衡度（%） */
  imbalanceValue: number
  /** 判级 */
  level: BalanceLevel
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
  /** 执行时间戳（待下发 → 已调节 当下记录） */
  executedAt?: number | null
  /** 执行时快照（基准口径）：执行开度 + 当时最新实测的流量、室温；执行时无实测则为 null */
  execSnapshot?: AdjustReadingSnapshot | null
  /** 复核时间戳（已调节 → 已复核 当下记录） */
  reviewedAt?: number | null
  /** 复核时快照（复测口径）：只取执行时间之后最新实测；无新测次不允许复核 */
  reviewSnapshot?: AdjustReadingSnapshot | null
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
