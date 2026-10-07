/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、复核统计与筛选。
 *
 * 两次口径（防止执行前旧读数冒充复测结果）：
 * - 基准口径：执行（待下发 → 已调节）当下，固化执行开度与当时最新实测的流量、室温；
 * - 复测口径：复核只认执行时间之后的新测次（执行当天以实测录入时刻严格晚于执行时刻为准），
 *   没有新测次一律挡住复核；复核当下把复测读数固化进快照。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, ROW_REVISION, type AdjustRow, type MeasureRow, type ValveRow } from '@/utils/db'
import {
  ADJUST_STATE_FLOW,
  type Adjust,
  type AdjustDraft,
  type AdjustReadingSnapshot,
  type AdjustState
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import {
  buildAdjustReading,
  measureForBaseline,
  measureForReview,
  type BalanceLevel
} from '@/utils/balance'

export interface AdjustEnriched {
  adjust: AdjustRow
  valve: ValveRow | null
  /** 执行时基准快照（已执行/已复核） */
  baseline: AdjustReadingSnapshot | null
  /** 已闭环的复测快照（已复核） */
  review: AdjustReadingSnapshot | null
  /** 已调节但未复核时，执行时间之后的最新实测（实时复测候选）；无新测次为 null */
  reviewCandidate: AdjustReadingSnapshot | null
  /** 复测候选对应的实测日期，用于提示「等哪天的新测次」 */
  reviewCandidateDate: string | null
  /** 是否已具备复核条件：必须有执行后的新测次 */
  reviewReady: boolean
  /** 待下发时按当前最新实测预览的失衡度，仅用于派单参考，不作为复核口径 */
  previewValue: number
  previewLevel: BalanceLevel
  /** 列表标签默认展示的失衡度与判级：已执行用基准，待下发用预览 */
  imbalanceValue: number
  level: BalanceLevel
}

type GenerateRankRow = {
  valve: Pick<ValveRow, 'id'>
  measured: number
  roomTempC: number
  imbalanceValue: number
  level: BalanceLevel
  suggestOpening: number
  basisText: string
}

/** 复核被挡住时抛出的业务错误，页面直接展示其提示文案 */
export class ReviewBlockedError extends Error {}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const measureTable = useIdbTable<MeasureRow>((database) => database.measures, { sortByUpdatedAt: false })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')

  /** 阀门 id → 该阀全部实测，按日期/录入时刻排序后供两次口径取数 */
  const measuresByValve = computed(() => {
    const map = new Map<string, MeasureRow[]>()
    measureTable.rows.value.forEach((measure) => {
      const list = map.get(measure.valveId)
      if (list) list.push(measure)
      else map.set(measure.valveId, [measure])
    })
    map.forEach((list) =>
      list.sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date.localeCompare(b.date)))
    )
    return map
  })

  function measuresOf(valveId: string): MeasureRow[] {
    return measuresByValve.value.get(valveId) ?? []
  }

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      const baseline = adjust.execSnapshot ?? null
      const review = adjust.reviewSnapshot ?? null

      let reviewCandidate: AdjustReadingSnapshot | null = null
      let reviewReady = false
      if (adjust.state === '已调节' && typeof adjust.executedAt === 'number' && valve) {
        const candidateMeasure = measureForReview(measuresOf(adjust.valveId), adjust.executedAt)
        if (candidateMeasure) {
          reviewCandidate = buildAdjustReading(candidateMeasure, valve.currentOpening, valve.designFlowM3h)
          reviewReady = true
        }
      }

      // 待下发时按当前最新实测预览，仅供派单/列表参考；执行后一律以快照为准
      let previewValue = 0
      let previewLevel: BalanceLevel = '平衡'
      if (adjust.state === '待下发' && valve) {
        const own = measuresOf(adjust.valveId)
        const latestMeasure = own[own.length - 1] ?? null
        if (latestMeasure) {
          const reading = buildAdjustReading(latestMeasure, valve.currentOpening, valve.designFlowM3h)
          previewValue = reading.imbalanceValue
          previewLevel = reading.level
        }
      }

      const imbalanceValue =
        adjust.state === '待下发' ? previewValue : baseline?.imbalanceValue ?? 0
      const level: BalanceLevel = adjust.state === '待下发' ? previewLevel : baseline?.level ?? '平衡'

      return {
        adjust,
        valve,
        baseline,
        review,
        reviewCandidate,
        reviewCandidateDate: reviewCandidate ? reviewCandidate.measureDate : null,
        reviewReady,
        previewValue,
        previewLevel,
        imbalanceValue,
        level
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
        execSnapshot: null,
        reviewedAt: null,
        reviewSnapshot: null
      },
      'aj'
    )) as AdjustRow
  }

  /**
   * 更新调节单。允许在编辑弹窗里手工切换状态；跨过执行/复核节点时与状态机走同一套
   * 快照规则：执行固化基准、复核必须有执行后新测次。
   */
  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const current = adjusts.value.find((item) => item.id === id)
    if (!current) return
    const next: Partial<AdjustRow> = { ...patch }
    if (patch.targetOpening !== undefined) next.targetOpening = Math.min(100, Math.max(0, Math.round(patch.targetOpening)))
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim()
    if (patch.reviewNote !== undefined) next.reviewNote = patch.reviewNote.trim()

    if (patch.state !== undefined && patch.state !== current.state) {
      if (patch.state === '已调节') {
        Object.assign(next, buildExecutionPatch(current.valveId, next.targetOpening ?? current.targetOpening))
      } else if (patch.state === '已复核') {
        Object.assign(next, await buildReviewPatch(id))
      } else if (patch.state === '待下发') {
        next.executedAt = null
        next.execSnapshot = null
        next.reviewedAt = null
        next.reviewSnapshot = null
      }
    }
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await adjustTable.remove(id)
  }

  /** 执行基准快照：执行开度 + 执行时间之前（含执行当天已录入）最近的一次实测 */
  function buildExecutionPatch(valveId: string, targetOpening: number): Partial<AdjustRow> {
    const now = Date.now()
    const valve = valveStore.valves.find((item) => item.id === valveId) ?? null
    const basisMeasure = measureForBaseline(measuresOf(valveId), now)
    const execSnapshot =
      basisMeasure && valve ? buildAdjustReading(basisMeasure, targetOpening, valve.designFlowM3h) : null
    return {
      state: '已调节',
      executedAt: now,
      execSnapshot,
      reviewedAt: null,
      reviewSnapshot: null
    }
  }

  /** 复测口径校验：取执行后最新实测；无新测次抛错挡住复核 */
  async function buildReviewPatch(id: string): Promise<Partial<AdjustRow>> {
    const adjust = await db.adjusts.get(id)
    if (!adjust) throw new ReviewBlockedError('调节单不存在')
    if (typeof adjust.executedAt !== 'number') {
      throw new ReviewBlockedError('该调节单尚未执行，无法复核')
    }
    const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
    if (!valve) throw new ReviewBlockedError('关联阀门已删除，无法复核')
    const freshMeasures = await db.measures.where('valveId').equals(adjust.valveId).toArray()
    const reviewMeasure = measureForReview(freshMeasures, adjust.executedAt)
    if (!reviewMeasure) {
      throw new ReviewBlockedError('执行后还没有新的实测测次，请先录入复测读数再复核（旧读数不能作为复测结果）')
    }
    return {
      state: '已复核',
      reviewedAt: Date.now(),
      reviewSnapshot: buildAdjustReading(reviewMeasure, valve.currentOpening, valve.designFlowM3h)
    }
  }

  /** 状态流转：已调节时把目标开度回写到阀门，并固化执行基准快照 */
  async function advance(id: string): Promise<AdjustState | null> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust) return null
    const next = ADJUST_STATE_FLOW[adjust.state]
    if (!next) return null
    if (next === '已复核') {
      // 复核入口（ReviewBlockedError 由页面捕获提示）
      await review(id, adjust.reviewNote || '复核合格')
      return next
    }
    // 执行：先固化基准快照，再回写阀门开度
    const patch = buildExecutionPatch(adjust.valveId, adjust.targetOpening)
    await adjustTable.update(id, patch)
    await valveStore.applyOpening(adjust.valveId, adjust.targetOpening)
    return next
  }

  /** 复核：写复核意见并闭环；没有执行后的新测次直接挡住 */
  async function review(id: string, note?: string): Promise<void> {
    const patch = await buildReviewPatch(id)
    await adjustTable.update(id, { ...patch, reviewNote: (note ?? '').trim() || '复核合格' })
  }

  /** 由失衡度排行批量生成调节单 */
  async function generateFromRank(rows: GenerateRankRow[]): Promise<number> {
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
        execSnapshot: null,
        reviewedAt: null,
        reviewSnapshot: null,
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  return {
    adjustTable,
    measureTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    reviewedPercent,
    measuresByValve,
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

export type { Adjust }
