<script setup lang="ts">
/**
 * /adjusts 调节单下发与复核
 * 执行时固化「基准快照」（开度 + 当时最新实测），复核只认执行时间之后的新测次并固化「复测快照」。
 * 消费 Adjust、Valve、Measure；复用 <FilterBar>、<EmptyPanel>、<StatBadge>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useAdjustStore, ReviewBlockedError, type AdjustEnriched } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import {
  ADJUST_STATES,
  ADJUST_STATE_FLOW,
  EMPTY_ADJUST_DRAFT,
  type Adjust,
  type AdjustDraft,
  type AdjustReadingSnapshot,
  type AdjustState
} from '@/types/adjust'
import { basisText, formatFlow, formatOpening, formatTemp } from '@/utils/balance'
import { exportAdjustCsv } from '@/utils/export'
import {
  DB_VERSION,
  clearAllTables,
  countAll,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const adjustStore = useAdjustStore()
const valveStore = useValveStore()
const stationStore = useStationStore()
const rank = useImbalanceRank()

// 灌入全部实测，store 据执行 / 复核时间点选取基准测次与复测测次
adjustStore.syncLatestMeasures(rank.measureTable.rows.value)
// 实测表本身就是响应式订阅，直接用 watch 跟随其变化（新测次录入后刷新复测可用性）
watch(
  () => rank.measureTable.rows.value,
  (rows) => adjustStore.syncLatestMeasures(rows),
  { deep: false }
)

const counts = ref<Record<string, number>>({})
const lastBackupAt = ref<string | null>(readLastBackupAt())
const stampedVersion = ref<number>(readStampedDbVersion())
const fileInput = ref<HTMLInputElement | null>(null)

void refreshCounts()

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: adjustStore.keyword,
  state: adjustStore.stateFilter
}))

const filterSelects = computed(() => [
  { key: 'state', label: '调节单状态', options: ADJUST_STATES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  adjustStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    stateFilter: (Array.isArray(model.state) ? model.state : []) as AdjustState[]
  })
}

const rows = computed(() => adjustStore.filtered)

const columns = [
  { colKey: 'valve', title: '阀门 / 楼栋', width: 190, cell: 'valveCell' },
  { colKey: 'readings', title: '执行基准 → 复核复测', minWidth: 360, cell: 'readingsCell' },
  { colKey: 'opening', title: '目标开度', width: 100, cell: 'openingCell' },
  { colKey: 'basis', title: '调节依据', minWidth: 240, cell: 'basisCell' },
  { colKey: 'executor', title: '执行人', width: 100 },
  { colKey: 'state', title: '状态', width: 100, cell: 'stateCell' },
  { colKey: 'note', title: '复核意见', width: 180, cell: 'noteCell' },
  { colKey: 'op', title: '操作', width: 250, cell: 'opCell' }
]

function rowKey(row: AdjustEnriched): string {
  return row.adjust.id
}

const levelTheme = (level: AdjustReadingSnapshot['level']): 'success' | 'warning' | 'primary' | 'danger' | 'default' => {
  if (level === '平衡') return 'success'
  if (level === '严重失衡') return 'danger'
  if (level === '偏大') return 'warning'
  if (level === '偏小') return 'primary'
  return 'default'
}

function snapshotText(snapshot: AdjustReadingSnapshot | null): string {
  if (!snapshot) return '尚未固化读数'
  const flow = snapshot.flowM3h === null ? '流量 —' : `流量 ${formatFlow(snapshot.flowM3h)}`
  const temp = snapshot.roomTempC === null ? '室温 —' : `室温 ${formatTemp(snapshot.roomTempC)}`
  const ratio = snapshot.flowM3h === null ? '' : ` · 流量比 ${snapshot.ratio.toFixed(2)}`
  const imb = snapshot.imbalanceValue === null ? '' : ` · 失衡度 ${snapshot.imbalanceValue.toFixed(1)}%`
  const date = snapshot.date ?? '无测次'
  return `${date} · 开度 ${formatOpening(snapshot.opening)} · ${flow} · ${temp}${ratio}${imb}`
}

/* ------------------------------ 编辑 ------------------------------ */

const dialogVisible = ref(false)
const dialogTitle = ref('调节单')
const form = reactive<AdjustDraft>({ ...EMPTY_ADJUST_DRAFT })
const formRef = ref()
let editingId: string | null = null

const rules = {
  valveId: [{ required: true, message: '请选择阀门', type: 'error' as const }],
  basis: [{ required: true, message: '请填写调节依据', type: 'error' as const }]
}

const valveOptions = computed(() =>
  valveStore.enriched.map((item) => ({
    label: `${item.valve.code} · ${item.building ? item.building.name : '未知楼栋'}（现 ${item.valve.currentOpening}%）`,
    value: item.valve.id
  }))
)

function openCreate(): void {
  editingId = null
  dialogTitle.value = '新建调节单'
  const first = rank.rows.value.find((row) => row.level !== '平衡')
  Object.assign(form, {
    ...EMPTY_ADJUST_DRAFT,
    valveId: first ? first.valve.id : valveOptions.value[0]?.value ?? '',
    targetOpening: first ? first.suggestOpening : 50,
    basis: first ? describeRow(first.valve.id) : ''
  })
  dialogVisible.value = true
}

function openEdit(row: AdjustEnriched): void {
  editingId = row.adjust.id
  dialogTitle.value = `编辑调节单 · ${row.valve ? row.valve.code : ''}`
  Object.assign(form, {
    valveId: row.adjust.valveId,
    targetOpening: row.adjust.targetOpening,
    basis: row.adjust.basis,
    executor: row.adjust.executor,
    state: row.adjust.state,
    reviewNote: row.adjust.reviewNote
  })
  dialogVisible.value = true
}

function describeRow(valveId: string): string {
  const row = rank.rowOf(valveId)
  if (!row) return ''
  return basisText({
    valve: row.valve,
    building: row.building,
    ratio: row.ratio,
    flowDeviation: row.flowDeviation,
    roomDeviation: row.roomDeviation,
    imbalanceValue: row.imbalanceValue,
    level: row.level
  })
}

async function submit(): Promise<void> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingId) {
    await adjustStore.updateAdjust(editingId, { ...form })
    MessagePlugin.success('调节单已更新')
  } else {
    await adjustStore.createAdjust({ ...form })
    MessagePlugin.success('调节单已创建')
  }
  dialogVisible.value = false
  await refreshCounts()
}

function remove(adjust: Adjust): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: '确认删除该调节单？删除后不可恢复。',
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await adjustStore.removeAdjust(adjust.id)
      MessagePlugin.success('调节单已删除')
      dialog.destroy()
      await refreshCounts()
    }
  })
}

/* ---------------------------- 状态流转 ---------------------------- */

function nextStateOf(state: AdjustState): AdjustState | null {
  return ADJUST_STATE_FLOW[state]
}

/** 已调节单据必须存在执行后新测次才允许进入复核，否则按钮置灰 */
function canAdvance(row: AdjustEnriched): boolean {
  const next = nextStateOf(row.adjust.state)
  if (!next) return false
  if (next === '已复核') return row.hasPostExecutionMeasure
  return true
}

const nextStateLabel = (state: AdjustState): string => {
  const next = nextStateOf(state)
  if (next === '已调节') return '执行调节'
  if (next === '已复核') return '复核闭环'
  return '已闭环'
}

async function advance(row: AdjustEnriched): Promise<void> {
  const next = ADJUST_STATE_FLOW[row.adjust.state]
  if (!next) {
    MessagePlugin.info('该调节单已完成复核闭环')
    return
  }
  if (next === '已复核') {
    await openReview(row)
    return
  }
  try {
    await adjustStore.advance(row.adjust.id)
    MessagePlugin.success('已执行调节：执行时开度、流量与室温已固化为复核基准，目标开度已回写阀门台账')
    await refreshCounts()
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '执行失败')
  }
}

/* ------------------------------ 复核 ------------------------------ */

const reviewVisible = ref(false)
const reviewNote = ref('')
const reviewTargetId = ref<string | null>(null)
const reviewTargetLabel = ref('')
const reviewRow = ref<AdjustEnriched | null>(null)

async function openReview(row: AdjustEnriched): Promise<void> {
  if (row.adjust.state !== '已调节') {
    MessagePlugin.info('请先执行调节，再进行复核')
    return
  }
  if (!row.hasPostExecutionMeasure) {
    const executedDate =
      row.adjust.executedAt === null ? '—' : new Date(row.adjust.executedAt).toISOString().slice(0, 10)
    MessagePlugin.warning(`执行日期 ${executedDate} 之后尚无新测次，执行前旧读数不能充当复测，请先录入实测`)
    detailTarget.value = row
    detailVisible.value = true
    return
  }
  reviewTargetId.value = row.adjust.id
  reviewTargetLabel.value = row.valve ? row.valve.code : ''
  reviewRow.value = row
  reviewNote.value = row.adjust.reviewNote || '复测流量比恢复至 0.95 以上，室温达标，同意闭环'
  reviewVisible.value = true
}

async function submitReview(): Promise<void> {
  if (!reviewTargetId.value) return
  try {
    await adjustStore.review(reviewTargetId.value, reviewNote.value)
    MessagePlugin.success('复核完成：已按执行后最新实测固化复测口径并闭环')
    reviewVisible.value = false
    await refreshCounts()
  } catch (error) {
    if (error instanceof ReviewBlockedError) {
      MessagePlugin.warning(error.message)
      reviewVisible.value = false
      return
    }
    MessagePlugin.error(error instanceof Error ? error.message : '复核失败')
  }
}

/* ---------------------------- 状态详情 ---------------------------- */

const detailVisible = ref(false)
const detailTarget = ref<AdjustEnriched | null>(null)

function openDetail(row: AdjustEnriched): void {
  detailTarget.value = row
  detailVisible.value = true
}

const detailBase = computed(() => detailTarget.value?.executionSnapshot ?? null)
const detailRetest = computed(() => detailTarget.value?.reviewSnapshot ?? null)

function formatDateTime(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/* ---------------------------- 备份导出 ---------------------------- */

function exportCsv(): void {
  const filename = exportAdjustCsv(
    stationStore.stations,
    stationStore.buildings,
    valveStore.valves,
    rank.measureTable.rows.value,
    adjustStore.adjusts
  )
  MessagePlugin.success(`已导出 ${filename}`)
}

function exportJson(): void {
  void (async () => {
    const payload = await exportSnapshot()
    const filename = `gbheatgrid-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    const iso = new Date().toISOString()
    stampBackupTime(iso)
    lastBackupAt.value = iso
    MessagePlugin.success(`已导出全量结构版本（含执行 / 复核两次口径）${filename}`)
  })()
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const payload = JSON.parse(await file.text()) as BackupPayload
    if (payload.app !== 'gbheatgrid') {
      MessagePlugin.error('存档文件格式不匹配（缺少 app: gbheatgrid 标识）')
      return
    }
    await importSnapshot(payload)
    MessagePlugin.success('存档已导入（执行 / 复核快照随调节单一并恢复）')
    await refreshCounts()
  } catch (error) {
    MessagePlugin.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

function reseed(): void {
  const dialog = DialogPlugin.confirm({
    header: '重置确认',
    body: '重置将清空现有数据并重新写入演示数据，确认继续？',
    confirmBtn: '重置并播种',
    cancelBtn: '取消',
    onConfirm: async () => {
      await resetDatabase()
      MessagePlugin.success('已重置为演示数据')
      dialog.destroy()
      await refreshCounts()
    }
  })
}

function clearData(): void {
  const dialog = DialogPlugin.confirm({
    header: '清空确认',
    body: '清空后所有本地数据将被删除且不可恢复，确认清空？',
    confirmBtn: '确认清空',
    cancelBtn: '取消',
    onConfirm: async () => {
      await clearAllTables()
      MessagePlugin.success('本地数据已清空')
      dialog.destroy()
      await refreshCounts()
    }
  })
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">调节单下发与复核</h2>
        <p class="page-head__desc">
          待下发 → 已调节（固化执行时开度 / 流量 / 室温为基准）→ 已复核（只认执行时间之后的新测次作复测）。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button variant="outline" @click="exportCsv">导出调节单 CSV</t-button>
        <t-button variant="outline" @click="exportJson">导出全量 JSON</t-button>
        <t-button variant="outline" @click="triggerImport">导入 JSON</t-button>
        <t-button theme="primary" @click="openCreate">新建调节单</t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待下发" :value="adjustStore.stateCounts['待下发']" suffix="张" tone="warning" />
      <StatBadge label="已调节" :value="adjustStore.stateCounts['已调节']" suffix="张" tone="info" />
      <StatBadge label="已复核" :value="adjustStore.stateCounts['已复核']" suffix="张" tone="success" />
      <StatBadge label="复核率" :value="adjustStore.reviewedPercent" :percent="adjustStore.reviewedPercent" suffix="%" tone="primary" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索阀门编号 / 执行人 / 依据"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">调节单（{{ rows.length }} / {{ adjustStore.adjusts.length }}）</h3>
        <span class="muted">复核只认执行之后的新测次；基准快照与复测快照均随数据持久化，重开页面仍在</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有调节单"
        description="可到失衡度计算页一键生成，或在此手工新建。"
        action-text="新建调节单"
        secondary-text="重置为演示数据"
        compact
        :show-seed="adjustStore.adjusts.length === 0"
        @action="openCreate"
        @secondary="reseed"
        @seed="reseed"
      />

      <t-table v-else :data="rows" :columns="columns" :row-key="rowKey" bordered stripe size="small">
        <template #valveCell="{ row }">
          <div>
            <strong>{{ row.valve ? row.valve.code : '阀门已删除' }}</strong>
            <div class="muted">
              {{ row.valve ? stationStore.stationById.get(row.valve.stationId)?.name ?? '' : '' }}
            </div>
          </div>
        </template>
        <template #readingsCell="{ row }">
          <div class="reading-cell">
            <div class="reading-cell__line">
              <t-tag size="small" theme="primary" variant="light">基准</t-tag>
              <t-tag
                v-if="row.executionSnapshot && row.executionSnapshot.level"
                size="small"
                :theme="levelTheme(row.executionSnapshot.level)"
                variant="light-outline"
              >
                {{ row.executionSnapshot.level }}
              </t-tag>
              <span class="muted reading-cell__text">{{ snapshotText(row.executionSnapshot) }}</span>
            </div>
            <div class="reading-cell__line">
              <t-tag size="small" theme="success" variant="light">复测</t-tag>
              <t-tag
                v-if="row.reviewSnapshot && row.reviewSnapshot.level"
                size="small"
                :theme="levelTheme(row.reviewSnapshot.level)"
                variant="light-outline"
              >
                {{ row.reviewSnapshot.level }}
              </t-tag>
              <span v-if="row.reviewSnapshot" class="muted reading-cell__text">{{ snapshotText(row.reviewSnapshot) }}</span>
              <span v-else-if="row.adjust.state === '待下发'" class="muted reading-cell__text">执行后生成</span>
              <span v-else-if="row.hasPostExecutionMeasure" class="reading-cell__text reading-cell__text--ready">
                已有执行后新测次，可复核
              </span>
              <span v-else class="reading-cell__text reading-cell__text--blocked">
                执行后无新测次，复核已挡住
              </span>
            </div>
            <t-button size="small" variant="text" theme="primary" @click="openDetail(row)">状态详情</t-button>
          </div>
        </template>
        <template #openingCell="{ row }">
          <strong>{{ formatOpening(row.adjust.targetOpening) }}</strong>
        </template>
        <template #basisCell="{ row }">
          <span class="muted">{{ row.adjust.basis }}</span>
        </template>
        <template #stateCell="{ row }">
          <t-tag
            size="small"
            variant="light"
            :theme="row.adjust.state === '已复核' ? 'success' : row.adjust.state === '已调节' ? 'primary' : 'warning'"
          >
            {{ row.adjust.state }}
          </t-tag>
        </template>
        <template #noteCell="{ row }">
          <span class="muted">{{ row.adjust.reviewNote || '—' }}</span>
        </template>
        <template #opCell="{ row }">
          <div class="toolbar">
            <t-button
              size="small"
              variant="text"
              theme="primary"
              :disabled="!canAdvance(row)"
              @click="advance(row)"
            >
              {{ nextStateLabel(row.adjust.state as AdjustState) }}
            </t-button>
            <t-button size="small" variant="text" theme="primary" @click="openEdit(row)">编辑</t-button>
            <t-button size="small" variant="text" theme="danger" @click="remove(row.adjust)">删除</t-button>
          </div>
        </template>
      </t-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">结构版本与本地数据</h3>
      <t-descriptions :column="3" bordered size="small">
        <t-descriptions-item label="IndexedDB 库名">gbheatgrid</t-descriptions-item>
        <t-descriptions-item label="数据结构版本">v{{ DB_VERSION }}（记录 v{{ stampedVersion }}）</t-descriptions-item>
        <t-descriptions-item label="最近备份">{{ lastBackupAt ?? '尚未备份' }}</t-descriptions-item>
        <t-descriptions-item label="换热站 / 楼栋">
          {{ counts.stations ?? 0 }} / {{ counts.buildings ?? 0 }}
        </t-descriptions-item>
        <t-descriptions-item label="阀门 / 实测">
          {{ counts.valves ?? 0 }} / {{ counts.measures ?? 0 }}
        </t-descriptions-item>
        <t-descriptions-item label="调节单">{{ counts.adjusts ?? 0 }}</t-descriptions-item>
      </t-descriptions>
      <div class="toolbar" style="margin-top: 14px">
        <t-button theme="primary" variant="outline" @click="exportJson">导出全量 JSON</t-button>
        <t-button variant="outline" @click="reseed">重置为演示数据</t-button>
        <t-button theme="danger" variant="outline" @click="clearData">清空本地数据</t-button>
        <t-button variant="text" theme="primary" @click="refreshCounts">刷新统计</t-button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
    </div>

    <t-dialog
      v-model:visible="dialogVisible"
      :header="dialogTitle"
      width="620px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submit"
    >
      <t-form ref="formRef" :data="form" :rules="rules" label-width="128px">
        <t-form-item label="阀门" name="valveId">
          <t-select v-model="form.valveId" :options="valveOptions" filterable placeholder="选择阀门" />
        </t-form-item>
        <t-form-item label="目标开度(%)" name="targetOpening">
          <t-input-number v-model="form.targetOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="调节依据" name="basis">
          <t-textarea v-model="form.basis" :autosize="{ minRows: 3, maxRows: 5 }" placeholder="如：流量比 0.74 偏小，需增大开度" />
        </t-form-item>
        <t-form-item label="执行人" name="executor">
          <t-input v-model="form.executor" placeholder="如 王海" />
        </t-form-item>
        <t-form-item label="状态" name="state">
          <t-select
            v-model="form.state"
            :options="ADJUST_STATES.map((item) => ({ label: item, value: item }))"
            style="width: 100%"
          />
        </t-form-item>
        <t-form-item label="复核意见" name="reviewNote">
          <t-input v-model="form.reviewNote" placeholder="复核合格可留空" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <t-dialog
      v-model:visible="reviewVisible"
      :header="`复核闭环 · ${reviewTargetLabel}`"
      width="560px"
      :confirm-btn="'确认闭环'"
      :cancel-btn="'取消'"
      @confirm="submitReview"
    >
      <div v-if="reviewRow" class="review-compare">
        <div class="review-compare__item">
          <div class="review-compare__label">执行基准（{{ detailBase?.date ?? '—' }}）</div>
          <div class="muted">{{ snapshotText(detailBase) }}</div>
        </div>
        <div class="review-compare__arrow">↓ 只认执行时间之后的新测次</div>
        <div class="review-compare__item">
          <div class="review-compare__label">
            复核复测（{{ reviewRow.liveRetest?.date ?? '—' }}）
          </div>
          <div class="muted">
            {{
              reviewRow.liveRetest
                ? snapshotText(reviewRow.liveRetest)
                : '执行后无新测次，无法复核'
            }}
          </div>
        </div>
      </div>
      <t-textarea v-model="reviewNote" :autosize="{ minRows: 3, maxRows: 6 }" placeholder="填写复核结论" />
      <p class="muted">复核依据为执行后新测次，执行前旧读数不会被当作复测结果。</p>
    </t-dialog>

    <t-dialog v-model:visible="detailVisible" header="调节单状态详情" width="640px" :confirm-btn="null" cancel-btn="关闭">
      <div v-if="detailTarget">
        <t-descriptions :column="2" bordered size="small" style="margin-bottom: 14px">
          <t-descriptions-item label="阀门编号">{{ detailTarget.valve ? detailTarget.valve.code : '阀门已删除' }}</t-descriptions-item>
          <t-descriptions-item label="状态">{{ detailTarget.adjust.state }}</t-descriptions-item>
          <t-descriptions-item label="目标开度">{{ formatOpening(detailTarget.adjust.targetOpening) }}</t-descriptions-item>
          <t-descriptions-item label="执行人">{{ detailTarget.adjust.executor }}</t-descriptions-item>
          <t-descriptions-item label="执行时间" :span="2">{{ formatDateTime(detailTarget.adjust.executedAt) }}</t-descriptions-item>
        </t-descriptions>

        <h4 class="snapshot-title">执行基准快照（执行时口径）</h4>
        <t-descriptions v-if="detailBase" :column="3" bordered size="small">
          <t-descriptions-item label="固化时间">{{ formatDateTime(detailBase.capturedAt) }}</t-descriptions-item>
          <t-descriptions-item label="开度">{{ formatOpening(detailBase.opening) }}</t-descriptions-item>
          <t-descriptions-item label="测次日期">{{ detailBase.date ?? '无测次' }}</t-descriptions-item>
          <t-descriptions-item label="流量">
            {{ detailBase.flowM3h === null ? '—' : formatFlow(detailBase.flowM3h) }}
          </t-descriptions-item>
          <t-descriptions-item label="室温">
            {{ detailBase.roomTempC === null ? '—' : formatTemp(detailBase.roomTempC) }}
          </t-descriptions-item>
          <t-descriptions-item label="流量比">
            {{ detailBase.flowM3h === null ? '—' : detailBase.ratio.toFixed(2) }}
          </t-descriptions-item>
          <t-descriptions-item label="失衡度">
            <t-tag v-if="detailBase.level" size="small" :theme="levelTheme(detailBase.level)" variant="light-outline">
              {{ detailBase.level }} · {{ detailBase.imbalanceValue?.toFixed(1) }}%
            </t-tag>
            <span v-else class="muted">—</span>
          </t-descriptions-item>
          <t-descriptions-item label="供 / 回温" :span="2">
            {{
              detailBase.supplyTempC === null || detailBase.returnTempC === null
                ? '—'
                : `${formatTemp(detailBase.supplyTempC)} / ${formatTemp(detailBase.returnTempC)}`
            }}
          </t-descriptions-item>
        </t-descriptions>
        <p v-else class="muted">待下发调节单尚未执行；执行瞬间会把当时开度与最新实测固化在此。</p>

        <h4 class="snapshot-title">复核复测快照（执行后新测次口径）</h4>
        <t-descriptions v-if="detailRetest" :column="3" bordered size="small">
          <t-descriptions-item label="复核时间">{{ formatDateTime(detailRetest.capturedAt) }}</t-descriptions-item>
          <t-descriptions-item label="开度">{{ formatOpening(detailRetest.opening) }}</t-descriptions-item>
          <t-descriptions-item label="测次日期">{{ detailRetest.date ?? '—' }}</t-descriptions-item>
          <t-descriptions-item label="流量">
            {{ detailRetest.flowM3h === null ? '—' : formatFlow(detailRetest.flowM3h) }}
          </t-descriptions-item>
          <t-descriptions-item label="室温">
            {{ detailRetest.roomTempC === null ? '—' : formatTemp(detailRetest.roomTempC) }}
          </t-descriptions-item>
          <t-descriptions-item label="流量比">
            {{ detailRetest.flowM3h === null ? '—' : detailRetest.ratio.toFixed(2) }}
          </t-descriptions-item>
          <t-descriptions-item label="失衡度">
            <t-tag v-if="detailRetest.level" size="small" :theme="levelTheme(detailRetest.level)" variant="light-outline">
              {{ detailRetest.level }} · {{ detailRetest.imbalanceValue?.toFixed(1) }}%
            </t-tag>
            <span v-else class="muted">—</span>
          </t-descriptions-item>
          <t-descriptions-item label="供 / 回温" :span="2">
            {{
              detailRetest.supplyTempC === null || detailRetest.returnTempC === null
                ? '—'
                : `${formatTemp(detailRetest.supplyTempC)} / ${formatTemp(detailRetest.returnTempC)}`
            }}
          </t-descriptions-item>
        </t-descriptions>
        <t-alert
          v-else-if="detailTarget.adjust.state === '已调节' && !detailTarget.hasPostExecutionMeasure"
          theme="warning"
          message="执行时间之后还没有新的实测，复核已被挡住；请先到「实测录入」页补录执行后测次，旧读数不会被采纳为复测。"
          style="margin-bottom: 8px"
        />
        <p v-else-if="detailTarget.adjust.state === '已调节'" class="muted">
          已存在执行后新测次，可点击「复核闭环」固化复测结果。
        </p>
        <p v-else class="muted">复核闭环后，执行后最新实测将固化在此。</p>

        <h4 class="snapshot-title">调节依据 / 复核意见</h4>
        <p class="muted" style="margin: 0 0 6px">{{ detailTarget.adjust.basis || '—' }}</p>
        <p class="muted" style="margin: 0">{{ detailTarget.adjust.reviewNote || '—' }}</p>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.reading-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.reading-cell__line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.reading-cell__text {
  font-size: 12px;
}

.reading-cell__text--ready {
  color: #1e8449;
}

.reading-cell__text--blocked {
  color: #c0392b;
}

.review-compare {
  background: #f7f9fc;
  border: 1px solid #e3e8ef;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.review-compare__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.review-compare__label {
  font-weight: 600;
  font-size: 13px;
}

.review-compare__arrow {
  text-align: center;
  color: #8a94a6;
  font-size: 12px;
  margin: 6px 0;
}

.snapshot-title {
  margin: 14px 0 8px;
  font-size: 14px;
}
</style>
