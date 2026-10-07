/**
 * 导出工具：整库 JSON 存档、调节单 CSV、剪贴板复制
 */
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { Adjust, AdjustReadingSnapshot } from '@/types/adjust'
import { buildAdjustReading, measureForReview } from '@/utils/balance'

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function exportBackupJson(payload: unknown): string {
  const filename = `gbheatgrid-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
  return filename
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** YYYY-MM-DD HH:mm（本地时区），CSV 时间列用 */
function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 由调节单与该阀实测解析两次口径：
 * 基准直接读执行时快照；复测优先读复核时固化的快照，未复核则实时取执行后最新测次，
 * 没有新测次时 review 为 null，绝不拿执行前旧读数顶替。
 */
function resolveAdjustReadings(
  adjust: Adjust,
  own: Measure[],
  valve: Valve | undefined
): {
  baseline: AdjustReadingSnapshot | null
  review: AdjustReadingSnapshot | null
} {
  const baseline = adjust.execSnapshot ?? null
  if (adjust.reviewSnapshot) return { baseline, review: adjust.reviewSnapshot }
  if (adjust.state !== '已调节' || typeof adjust.executedAt !== 'number' || !valve) {
    return { baseline, review: null }
  }
  const reviewMeasure = measureForReview(own, adjust.executedAt)
  return {
    baseline,
    review: reviewMeasure ? buildAdjustReading(reviewMeasure, valve.currentOpening, valve.designFlowM3h) : null
  }
}

/** 导出调节单 CSV（执行基准与执行后复测两次口径并列） */
export function exportAdjustCsv(
  stations: Station[],
  buildings: Building[],
  valves: Valve[],
  measures: Measure[],
  adjusts: Adjust[]
): string {
  const grouped = new Map<string, Measure[]>()
  measures.forEach((measure) => {
    const list = grouped.get(measure.valveId)
    if (list) list.push(measure)
    else grouped.set(measure.valveId, [measure])
  })
  grouped.forEach((list) =>
    list.sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date.localeCompare(b.date)))
  )

  const header = [
    '换热站',
    '楼栋',
    '供热方式',
    '阀门编号',
    '口径DN',
    '位置',
    '设计流量(m³/h)',
    '执行时间',
    '基准开度(%)',
    '基准实测日期',
    '基准流量(m³/h)',
    '基准室温(℃)',
    '基准流量比',
    '基准失衡度(%)',
    '基准判级',
    '复测时间',
    '复测开度(%)',
    '复测实测日期',
    '复测流量(m³/h)',
    '复测室温(℃)',
    '复测流量比',
    '复测失衡度(%)',
    '复测判级',
    '复测口径状态',
    '目标开度(%)',
    '调节依据',
    '执行人',
    '状态',
    '复核意见'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  adjusts.forEach((adjust) => {
    const valve = valves.find((item) => item.id === adjust.valveId)
    const building = valve ? buildings.find((item) => item.id === valve.buildingId) ?? null : null
    const station = building ? stations.find((item) => item.id === building.stationId) ?? null : null
    const design = valve ? valve.designFlowM3h : 0
    const { baseline, review } = resolveAdjustReadings(adjust, grouped.get(adjust.valveId) ?? [], valve)
    const reviewStatus =
      adjust.state === '待下发'
        ? '未执行'
        : review
          ? adjust.state === '已复核'
            ? '复测已闭环'
            : '已有新测次待复核'
          : '执行后无新测次（复核被挡）'

    lines.push(
      [
        station ? station.name : '—',
        building ? building.name : '—',
        building ? building.heatMode : '—',
        valve ? valve.code : '—',
        valve ? valve.dn : '—',
        valve ? valve.position : '—',
        design,
        adjust.executedAt ? formatDateTime(adjust.executedAt) : '—',
        baseline ? baseline.opening : '—',
        baseline ? baseline.measureDate : '—',
        baseline ? baseline.flowM3h : '—',
        baseline ? baseline.roomTempC : '—',
        baseline ? baseline.ratio.toFixed(2) : '—',
        baseline ? baseline.imbalanceValue.toFixed(1) : '—',
        baseline ? baseline.level : '—',
        adjust.reviewedAt ? formatDateTime(adjust.reviewedAt) : '—',
        review ? review.opening : '—',
        review ? review.measureDate : '—',
        review ? review.flowM3h : '—',
        review ? review.roomTempC : '—',
        review ? review.ratio.toFixed(2) : '—',
        review ? review.imbalanceValue.toFixed(1) : '—',
        review ? review.level : '—',
        reviewStatus,
        adjust.targetOpening,
        adjust.basis,
        adjust.executor,
        adjust.state,
        adjust.reviewNote
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `调节单-${stampSuffix()}.csv`
  download(filename, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 导出失衡度排行 CSV */
export function exportBalanceCsv(
  rows: Array<{
    station: Station | null
    building: Building | null
    valve: Valve
    measured: number
    ratio: number
    flowDeviation: number
    roomDeviation: number
    imbalanceValue: number
    level: string
  }>
): string {
  const header = ['换热站', '楼栋', '阀门编号', '设计流量', '实测流量', '流量比', '流量偏差(%)', '室温偏差(℃)', '失衡度(%)', '判级']
  const lines: string[] = [header.map(csvCell).join(',')]
  rows.forEach((row) => {
    lines.push(
      [
        row.station ? row.station.name : '—',
        row.building ? row.building.name : '—',
        row.valve.code,
        row.valve.designFlowM3h,
        row.measured,
        row.ratio.toFixed(2),
        row.flowDeviation.toFixed(1),
        row.roomDeviation.toFixed(1),
        row.imbalanceValue.toFixed(1),
        row.level
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `失衡度排行-${stampSuffix()}.csv`
  download(filename, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 解析批量粘贴的实测数据：每行 阀门编号,日期,流量,供温,回温,室温[,操作人] */
export function parseMeasureBatch(text: string): Array<{
  code: string
  date: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
}> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/[,\t;]/).map((item) => item.trim())
      return {
        code: parts[0] ?? '',
        date: parts[1] ?? '',
        flowM3h: Number(parts[2] ?? 0),
        supplyTempC: Number(parts[3] ?? 0),
        returnTempC: Number(parts[4] ?? 0),
        roomTempC: Number(parts[5] ?? 0),
        operator: parts[6] ?? ''
      }
    })
    .filter((item) => item.code.length > 0)
}
