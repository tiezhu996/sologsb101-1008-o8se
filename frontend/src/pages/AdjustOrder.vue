<script setup lang="ts">
/**
 * /adjusts 调节单下发与复核
 * 生成目标开度、执行回填、复核确认并导出全量 JSON。
 * 消费 Adjust、Valve、Measure；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<BalanceTag>。
 *
 * 两次口径：执行时固化开度与当时流量、室温（基准）；复核只认执行时间之后的新测次（复测），
 * 没有新测次时复核被挡住，防止旧读数冒充复测结果。
 */
import { computed, reactive, ref } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import { useAdjustStore, ReviewBlockedError, type AdjustEnriched } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import {
  ADJUST_STATES,
  ADJUST_STATE_FLOW,
  EMPTY_ADJUST_DRAFT,
  type Adjust,
  type AdjustDraft,
  type AdjustReadingSnapshot,
  type AdjustState
} from '@/types/adjust'
import { formatOpening } from '@/utils/balance'
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
  { colKey: 'baseline', title: '执行基准（执行时快照）', minWidth: 210, cell: 'baselineCell' },
  { colKey: 'review', title: '执行后复测', minWidth: 210, cell: 'reviewCell' },
  { colKey: 'opening', title: '当前 → 目标开度', width: 160, cell: 'openingCell' },
  { colKey: 'basis', title: '调节依据', minWidth: 240, cell: 'basisCell' },
  { colKey: 'executor', title: '执行人', width: 100 },
  { colKey: 'state', title: '状态', width: 100, cell: 'stateCell' },
  { colKey: 'note', title: '复核意见', width: 170, cell: 'noteCell' },
  { colKey: 'op', title: '操作', width: 250, cell: 'opCell' }
]

function rowKey(row: AdjustEnriched): string {
  return row.adjust.id
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
  Object.assign(form, {
    ...EMPTY_ADJUST_DRAFT,
    valveId: valveOptions.value[0]?.value ?? '',
    targetOpening: 50,
    basis: ''
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

async function submit(): Promise<void> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  try {
    if (editingId) {
      await adjustStore.updateAdjust(editingId, { ...form })
      MessagePlugin.success('调节单已更新')
    } else {
      await adjustStore.createAdjust({ ...form })
      MessagePlugin.success('调节单已创建')
    }
    dialogVisible.value = false
    await refreshCounts()
  } catch (error) {
    if (error instanceof ReviewBlockedError) {
      MessagePlugin.warning(error.message)
    } else {
      MessagePlugin.error('保存失败，请重试')
    }
  }
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
    openReview(row)
    return
  }
  await adjustStore.advance(row.adjust.id)
  MessagePlugin.success(`已执行：开度回写到阀门台账，并固化执行时流量/室温基准快照`)
  await refreshCounts()
}

/* ------------------------------ 复核 ------------------------------ */

const reviewVisible = ref(false)
const reviewNote = ref('')
const reviewTargetId = ref<string | null>(null)
const reviewTargetLabel = ref('')
const reviewTargetRow = ref<AdjustEnriched | null>(null)

function openReview(row: AdjustEnriched): void {
  if (!row.reviewReady || !row.reviewCandidate) {
    // 没有执行后的新测次：挡住，不允许用执行前旧读数复核
    MessagePlugin.warning('执行后还没有新的实测测次，请先到「实测录入」登记复测读数，再复核闭环')
    return
  }
  reviewTargetId.value = row.adjust.id
  reviewTargetRow.value = row
  reviewTargetLabel.value = row.valve ? row.valve.code : ''
  reviewNote.value =
    row.adjust.reviewNote ||
    `已按 ${row.reviewCandidate.measureDate} 复测：流量比 ${row.reviewCandidate.ratio.toFixed(2)}、` +
      `室温 ${row.reviewCandidate.roomTempC.toFixed(1)}℃、失衡度 ${row.reviewCandidate.imbalanceValue.toFixed(1)}%，同意闭环`
  reviewVisible.value = true
}

async function submitReview(): Promise<void> {
  if (!reviewTargetId.value) return
  try {
    await adjustStore.review(reviewTargetId.value, reviewNote.value)
    MessagePlugin.success('复核完成，复测读数已固化，调节单闭环')
    reviewVisible.value = false
    await refreshCounts()
  } catch (error) {
    if (error instanceof ReviewBlockedError) {
      MessagePlugin.warning(error.message)
      reviewVisible.value = false
    } else {
      MessagePlugin.error('复核失败，请重试')
    }
  }
}

/* ---------------------------- 状态详情 ---------------------------- */

const detailVisible = ref(false)
const detailRow = ref<AdjustEnriched | null>(null)

function openDetail(row: AdjustEnriched): void {
  detailRow.value = row
  detailVisible.value = true
}

function formatDateTime(value: number | null | undefined): string {
  if (typeof value !== 'number') return '—'
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function snapshotText(snapshot: AdjustReadingSnapshot | null): string {
  if (!snapshot) return '—'
  return `${snapshot.measureDate} · 流量 ${snapshot.flowM3h.toFixed(1)} / 室温 ${snapshot.roomTempC.toFixed(1)}℃ · 比 ${snapshot.ratio.toFixed(2)} · 失衡 ${snapshot.imbalanceValue.toFixed(1)}%`
}

/* ---------------------------- 备份导出 ---------------------------- */

function exportCsv(): void {
  const filename = exportAdjustCsv(
    stationStore.stations,
    stationStore.buildings,
    valveStore.valves,
    adjustStore.measureTable.rows,
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
    MessagePlugin.success(`已导出全量结构版本 ${filename}`)
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
    MessagePlugin.success('存档已导入（含执行基准 / 复测两次口径快照）')
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
          执行（待下发 → 已调节）时固化开度与当时流量、室温作为基准；复核只认执行时间之后的新测次，
          无新测次一律挡住，旧读数不能冒充复测结果。
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
        <span class="muted">基准＝执行时快照；复测＝执行后最新测次，无新测次不可复核</span>
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
        <template #baselineCell="{ row }">
          <template v-if="row.baseline">
            <BalanceTag :level="row.baseline.level" :imbalance="row.baseline.imbalanceValue" size="small" />
            <div class="muted caliber-line">{{ snapshotText(row.baseline) }}</div>
            <div class="muted caliber-line">基准开度 {{ formatOpening(row.baseline.opening) }} · {{ formatDateTime(row.adjust.executedAt) }}</div>
          </template>
          <BalanceTag v-else-if="row.adjust.state === '待下发' && row.valve" :level="row.previewLevel" :imbalance="row.previewValue" size="small" />
          <span v-else class="muted">执行时无实测读数</span>
        </template>
        <template #reviewCell="{ row }">
          <template v-if="row.review">
            <BalanceTag :level="row.review.level" :imbalance="row.review.imbalanceValue" size="small" />
            <div class="muted caliber-line">{{ snapshotText(row.review) }}</div>
            <div class="muted caliber-line">复测开度 {{ formatOpening(row.review.opening) }} · {{ formatDateTime(row.adjust.reviewedAt) }}</div>
          </template>
          <template v-else-if="row.adjust.state === '已调节'">
            <template v-if="row.reviewCandidate">
              <BalanceTag :level="row.reviewCandidate.level" :imbalance="row.reviewCandidate.imbalanceValue" size="small" />
              <div class="muted caliber-line">{{ snapshotText(row.reviewCandidate) }}</div>
              <div class="muted caliber-line is-ready">已有执行后新测次，可复核</div>
            </template>
            <t-alert
              theme="warning"
              message="执行后无新测次"
              description="请先录入执行日期之后的复测读数"
              size="small"
            />
          </template>
          <span v-else class="muted">—</span>
        </template>
        <template #openingCell="{ row }">
          {{ row.valve ? formatOpening(row.valve.currentOpening) : '—' }} →
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
              v-if="row.adjust.state === '已调节' && !row.reviewReady"
              size="small"
              variant="text"
              theme="warning"
              disabled
            >
              待复测（新测次）
            </t-button>
            <t-button
              v-else
              size="small"
              variant="text"
              theme="primary"
              :disabled="!nextStateOf(row.adjust.state as AdjustState)"
              @click="advance(row)"
            >
              {{ nextStateLabel(row.adjust.state as AdjustState) }}
            </t-button>
            <t-button size="small" variant="text" theme="primary" @click="openDetail(row)">状态详情</t-button>
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
      <t-alert
        v-if="form.state !== '待下发'"
        theme="warning"
        message="手工切换到「已调节 / 已复核」同样受两次口径约束：执行固化基准快照，复核必须存在执行后的新测次。"
      />
    </t-dialog>

    <t-dialog
      v-model:visible="reviewVisible"
      :header="`复核闭环 · ${reviewTargetLabel}`"
      width="560px"
      :confirm-btn="'确认闭环'"
      :cancel-btn="'取消'"
      @confirm="submitReview"
    >
      <template v-if="reviewTargetRow">
        <t-descriptions :column="1" bordered size="small" style="margin-bottom: 12px">
          <t-descriptions-item label="执行基准">
            <BalanceTag
              v-if="reviewTargetRow.baseline"
              :level="reviewTargetRow.baseline.level"
              :imbalance="reviewTargetRow.baseline.imbalanceValue"
              size="small"
            />
            <span class="muted">{{ snapshotText(reviewTargetRow.baseline) }}</span>
          </t-descriptions-item>
          <t-descriptions-item label="执行后复测">
            <BalanceTag
              v-if="reviewTargetRow.reviewCandidate"
              :level="reviewTargetRow.reviewCandidate.level"
              :imbalance="reviewTargetRow.reviewCandidate.imbalanceValue"
              size="small"
            />
            <span class="muted">{{ snapshotText(reviewTargetRow.reviewCandidate) }}</span>
          </t-descriptions-item>
        </t-descriptions>
      </template>
      <t-textarea v-model="reviewNote" :autosize="{ minRows: 3, maxRows: 6 }" placeholder="填写复核结论" />
      <p class="muted">复测只采用执行时间之后的新测次；确认后复测读数固化进调节单，页面重开仍保留两次口径。</p>
    </t-dialog>

    <t-dialog
      v-model:visible="detailVisible"
      :header="`状态详情 · ${detailRow?.valve ? detailRow.valve.code : ''}`"
      width="640px"
      :confirm-btn="null"
      cancel-btn="关闭"
    >
      <template v-if="detailRow">
        <t-descriptions :column="2" bordered size="small">
          <t-descriptions-item label="当前状态">{{ detailRow.adjust.state }}</t-descriptions-item>
          <t-descriptions-item label="执行人">{{ detailRow.adjust.executor }}</t-descriptions-item>
          <t-descriptions-item label="当前开度 → 目标开度">
            {{ detailRow.valve ? formatOpening(detailRow.valve.currentOpening) : '—' }}
            → {{ formatOpening(detailRow.adjust.targetOpening) }}
          </t-descriptions-item>
          <t-descriptions-item label="执行时间">{{ formatDateTime(detailRow.adjust.executedAt) }}</t-descriptions-item>
          <t-descriptions-item label="复核时间">{{ formatDateTime(detailRow.adjust.reviewedAt) }}</t-descriptions-item>
        </t-descriptions>

        <h4 class="detail-subtitle">执行基准（执行时快照）</h4>
        <t-descriptions v-if="detailRow.baseline" :column="2" bordered size="small">
          <t-descriptions-item label="基准开度">{{ formatOpening(detailRow.baseline.opening) }}</t-descriptions-item>
          <t-descriptions-item label="基准实测日期">{{ detailRow.baseline.measureDate }}</t-descriptions-item>
          <t-descriptions-item label="基准流量">{{ detailRow.baseline.flowM3h.toFixed(1) }} m³/h</t-descriptions-item>
          <t-descriptions-item label="基准室温">{{ detailRow.baseline.roomTempC.toFixed(1) }} ℃</t-descriptions-item>
          <t-descriptions-item label="基准流量比">{{ detailRow.baseline.ratio.toFixed(2) }}</t-descriptions-item>
          <t-descriptions-item label="基准流量偏差">{{ detailRow.baseline.flowDeviation.toFixed(1) }}%</t-descriptions-item>
          <t-descriptions-item label="基准室温偏差">{{ detailRow.baseline.roomDeviation.toFixed(1) }}℃</t-descriptions-item>
          <t-descriptions-item label="基准失衡度 / 判级">
            <BalanceTag :level="detailRow.baseline.level" :imbalance="detailRow.baseline.imbalanceValue" size="small" />
          </t-descriptions-item>
        </t-descriptions>
        <p v-else class="muted">
          {{ detailRow.adjust.state === '待下发' ? '尚未执行，执行时记录基准。' : '执行时该阀门没有可用实测读数。' }}
        </p>

        <h4 class="detail-subtitle">执行后复测（仅认执行时间之后的新测次）</h4>
        <t-descriptions
          v-if="detailRow.review ?? detailRow.reviewCandidate"
          :column="2"
          bordered
          size="small"
        >
          <t-descriptions-item label="复测开度">
            {{ formatOpening((detailRow.review ?? detailRow.reviewCandidate)!.opening) }}
          </t-descriptions-item>
          <t-descriptions-item label="复测实测日期">
            {{ (detailRow.review ?? detailRow.reviewCandidate)!.measureDate }}
          </t-descriptions-item>
          <t-descriptions-item label="复测流量">
            {{ (detailRow.review ?? detailRow.reviewCandidate)!.flowM3h.toFixed(1) }} m³/h
          </t-descriptions-item>
          <t-descriptions-item label="复测室温">
            {{ (detailRow.review ?? detailRow.reviewCandidate)!.roomTempC.toFixed(1) }} ℃
          </t-descriptions-item>
          <t-descriptions-item label="复测流量比">
            {{ (detailRow.review ?? detailRow.reviewCandidate)!.ratio.toFixed(2) }}
          </t-descriptions-item>
          <t-descriptions-item label="复测流量偏差">
            {{ (detailRow.review ?? detailRow.reviewCandidate)!.flowDeviation.toFixed(1) }}%
          </t-descriptions-item>
          <t-descriptions-item label="复测室温偏差">
            {{ (detailRow.review ?? detailRow.reviewCandidate)!.roomDeviation.toFixed(1) }}℃
          </t-descriptions-item>
          <t-descriptions-item label="复测失衡度 / 判级">
            <BalanceTag
              :level="(detailRow.review ?? detailRow.reviewCandidate)!.level"
              :imbalance="(detailRow.review ?? detailRow.reviewCandidate)!.imbalanceValue"
              size="small"
            />
          </t-descriptions-item>
        </t-descriptions>
        <t-alert
          v-else-if="detailRow.adjust.state === '已调节'"
          theme="warning"
          message="执行后暂无新测次，复核已被挡住"
          description="请先在实测录入页登记执行日期之后的复测读数。"
        />
        <p v-else class="muted">—</p>

        <h4 class="detail-subtitle">调节依据与复核意见</h4>
        <t-descriptions :column="1" bordered size="small">
          <t-descriptions-item label="调节依据">{{ detailRow.adjust.basis || '—' }}</t-descriptions-item>
          <t-descriptions-item label="复核意见">{{ detailRow.adjust.reviewNote || '—' }}</t-descriptions-item>
        </t-descriptions>
      </template>
    </t-dialog>
  </div>
</template>

<style scoped>
.caliber-line {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
}

.caliber-line.is-ready {
  color: #b45309;
}

.detail-subtitle {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
</style>
