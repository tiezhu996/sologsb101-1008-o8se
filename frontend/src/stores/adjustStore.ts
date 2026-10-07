/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、执行 / 复核两次读数口径与筛选统计。
 *
 * 口径约定（防止旧读数冒充复测）：
 * - 执行（待下发 → 已调节）：固化「执行时快照」——目标开度 + 执行当时的最新实测，作为复核基准；
 * - 复核（已调节 → 已复核）：只认执行时间之后录入的最新实测，固化为「复核快照」复测；
 *   执行之后没有新测次时一律拦截，不允许复核闭环。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, makeAdjustSnapshot, type AdjustRow, type MeasureRow } from '@/utils/db'
import {
  ADJUST_STATE_FLOW,
  type Adjust,
  type AdjustDraft,
  type AdjustReadingSnapshot,
  type AdjustState
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import type { Valve } from '@/types/valve'

export interface AdjustEnriched {
  adjust: Adjust
  valve: Valve | null
  /** 执行时基准快照（执行当时的开度与最新实测） */
  executionSnapshot: AdjustReadingSnapshot | null
  /** 复核时复测快照（复核动作固化的执行后最新实测，已复核后用于持久化展示） */
  reviewSnapshot: AdjustReadingSnapshot | null
  /** 当前执行时间之后的最新实测尚未固化时的待复测预览（已复核后仍跟踪最新测次） */
  liveRetest: AdjustReadingSnapshot | null
  /** 当前是否存在执行时间之后、可用于复核的新测次 */
  hasPostExecutionMeasure: boolean
}

export class ReviewBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewBlockedError'
  }
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')
  /** 全部实测（按日期升序），供执行 / 复核时点选取测次 */
  const measureRows = ref<MeasureRow[]>([])

  /** 由失衡度排行灌入最新实测集合，状态流转据此按时间点选测次 */
  function syncLatestMeasures(rows: MeasureRow[]): void {
    measureRows.value = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
  }

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 该阀门在指定时间点之前（允许执行当日、执行时刻之前已录入）的最新一条实测 */
  function latestMeasureBefore(valveId: string, boundary: number): MeasureRow | null {
    const boundaryDate = new Date(boundary).toISOString().slice(0, 10)
    const own = measureRows.value.filter(
      (item) => item.valveId === valveId && (item.date < boundaryDate || (item.date === boundaryDate && item.createdAt <= boundary))
    )
    return own.length > 0 ? own[own.length - 1] : null
  }

  /** 该阀门在执行时间之后（测次日期晚于执行日，或同日但录入时刻晚于执行）的最新实测——复核唯一认可的复测来源 */
  function latestMeasureAfterExecution(adjust: AdjustRow): MeasureRow | null {
    if (adjust.executedAt === null) return null
    const executedAt = adjust.executedAt
    const executedDate = new Date(executedAt).toISOString().slice(0, 10)
    const own = measureRows.value.filter(
      (item) =>
        item.valveId === adjust.valveId &&
        (item.date > executedDate || (item.date === executedDate && item.createdAt > executedAt))
    )
    return own.length > 0 ? own[own.length - 1] : null
  }

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      const postMeasure = latestMeasureAfterExecution(adjust)
      const liveRetest =
        postMeasure && valve
          ? makeAdjustSnapshot({
              capturedAt: postMeasure.createdAt,
              opening: adjust.targetOpening,
              measure: postMeasure,
              designFlowM3h: valve.designFlowM3h
            })
          : null
      return {
        adjust,
        valve,
        executionSnapshot: adjust.executionSnapshot ?? null,
        reviewSnapshot: adjust.reviewSnapshot ?? null,
        liveRetest,
        hasPostExecutionMeasure: postMeasure !== null
      }
    })
  )

  const filtered = computed<AdjustEnriched[]>(() =>
    enriched.value.filter((item) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(item.adjust.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      return (
        (item.valve ? item.valve.code.toLowerCase().includes(text) : false) ||
        item.adjust.executor.toLowerCase().includes(text) ||
        item.adjust.basis.toLowerCase().includes(text)
      )
    })
  )

  const stateCounts = computed<Record<AdjustState, number>>(() => {
    const counts: Record<AdjustState, number> = { 待下发: 0, 已调节: 0, 已复核: 0 }
    adjusts.value.forEach((adjust) => {
      counts[adjust.state] += 1
    })
    return counts
  })

  const reviewedPercent = computed(() =>
    adjusts.value.length === 0 ? 0 : Math.round((stateCounts.value['已复核'] / adjusts.value.length) * 100)
  )

  function patchFilter(patch: { stateFilter?: AdjustState[]; keyword?: string }): void {
    if (patch.stateFilter) stateFilter.value = patch.stateFilter
    if (patch.keyword !== undefined) keyword.value = patch.keyword
  }

  function resetFilter(): void {
    stateFilter.value = []
    keyword.value = ''
  }

  const hasAdjust = (valveId: string): boolean => adjusts.value.some((adjust) => adjust.valveId === valveId)

  async function createAdjust(draft: AdjustDraft): Promise<AdjustRow> {
    return (await adjustTable.create(
      {
        valveId: draft.valveId,
        targetOpening: Math.min(100, Math.max(0, Math.round(draft.targetOpening))),
        basis: draft.basis.trim(),
        executor: draft.executor.trim() || '待指派',
        state: draft.state,
        reviewNote: draft.reviewNote.trim(),
        executedAt: null,
        executionSnapshot: null,
        reviewSnapshot: null
      },
      'aj'
    )) as AdjustRow
  }

  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const next: Partial<AdjustRow> = { ...patch }
    if (patch.targetOpening !== undefined) next.targetOpening = Math.min(100, Math.max(0, Math.round(patch.targetOpening)))
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim()
    if (patch.reviewNote !== undefined) next.reviewNote = patch.reviewNote.trim()
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await adjustTable.remove(id)
  }

  /**
   * 状态流转：
   * - 推进到「已调节」时，记下目标开度与当时最新实测（执行基准快照），并把开度回写阀门；
   * - 推进到「已复核」时，只认执行时间之后的新测次；没有新测次直接抛 ReviewBlockedError 拦截。
   */
  async function advance(id: string): Promise<AdjustState | null> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust) return null
    const next = ADJUST_STATE_FLOW[adjust.state]
    if (!next) return null

    if (next === '已调节') {
      const executedAt = Date.now()
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId)
      const design = valve ? valve.designFlowM3h : 0
      const baseMeasure = latestMeasureBefore(adjust.valveId, executedAt)
      const snapshot = makeAdjustSnapshot({
        capturedAt: executedAt,
        opening: adjust.targetOpening,
        measure: baseMeasure,
        designFlowM3h: design
      })
      await adjustTable.update(id, { state: next, executedAt, executionSnapshot: snapshot, reviewSnapshot: null })
      await valveStore.applyOpening(adjust.valveId, adjust.targetOpening)
      return next
    }

    if (next === '已复核') {
      throw new ReviewBlockedError('请通过复核入口提交：需存在执行时间之后的新测次')
    }

    await adjustTable.update(id, { state: next })
    return next
  }

  /**
   * 复核闭环：只认执行时间之后的最新实测作为复测。
   * 执行后没有新测次时抛 ReviewBlockedError，由页面提示并挡住闭环。
   */
  async function review(id: string, note: string): Promise<AdjustRow> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust) throw new ReviewBlockedError('调节单不存在')
    if (adjust.state !== '已调节') {
      throw new ReviewBlockedError('仅「已调节」状态的调节单可以复核')
    }
    if (adjust.executedAt === null) {
      throw new ReviewBlockedError('缺少执行时间记录，无法确认复测测次')
    }
    const retest = latestMeasureAfterExecution(adjust)
    if (!retest) {
      const executedDate = new Date(adjust.executedAt).toISOString().slice(0, 10)
      throw new ReviewBlockedError(
        `执行日期 ${executedDate} 之后尚无新的实测，执行前的旧读数不能作为复测结果，请先录入执行后测次再复核`
      )
    }
    const valve = valveStore.valves.find((item) => item.id === adjust.valveId)
    const reviewSnapshot = makeAdjustSnapshot({
      capturedAt: Date.now(),
      opening: adjust.targetOpening,
      measure: retest,
      designFlowM3h: valve ? valve.designFlowM3h : 0
    })
    const updated: AdjustRow = {
      ...adjust,
      state: '已复核',
      reviewNote: note.trim() || '复核合格',
      reviewSnapshot
    }
    await db.adjusts.put(updated)
    return updated
  }

  /** 由失衡度排行批量生成调节单 */
  async function generateFromRank(
    rows: Array<{ valve: Valve; measured: number; roomTempC: number; imbalanceValue: number; level: string; suggestOpening: number; basisText: string }>
  ): Promise<number> {
    const now = Date.now()
    const payload: AdjustRow[] = rows
      .filter((row) => row.level === '严重失衡' || row.level === '偏大' || row.level === '偏小')
      .filter((row) => !hasAdjust(row.valve.id))
      .map((row, index) => ({
        id: `aj_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
        valveId: row.valve.id,
        targetOpening: row.suggestOpening,
        basis: row.basisText,
        executor: '待指派',
        state: '待下发' as AdjustState,
        reviewNote: '',
        executedAt: null,
        executionSnapshot: null,
        reviewSnapshot: null,
        createdAt: now,
        updatedAt: now
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  return {
    adjustTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    reviewedPercent,
    syncLatestMeasures,
    measureRows,
    patchFilter,
    resetFilter,
    hasAdjust,
    createAdjust,
    updateAdjust,
    removeAdjust,
    advance,
    review,
    generateFromRank
  }
})
