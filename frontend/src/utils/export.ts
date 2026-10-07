/**
 * 导出工具：整库 JSON 存档、调节单 CSV、剪贴板复制
 */
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { Adjust } from '@/types/adjust'
import { imbalance, balanceLevel, flowRatio } from '@/utils/balance'

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

/** 导出调节单 CSV（执行基准与复核复测两次口径分列） */
export function exportAdjustCsv(
  stations: Station[],
  buildings: Building[],
  valves: Valve[],
  measures: Measure[],
  adjusts: Adjust[]
): string {
  const header = [
    '换热站',
    '楼栋',
    '供热方式',
    '阀门编号',
    '口径DN',
    '位置',
    '设计流量(m³/h)',
    '目标开度(%)',
    '执行人',
    '状态',
    '执行时间',
    '基准开度(%)',
    '基准测次日期',
    '基准流量(m³/h)',
    '基准室温(℃)',
    '基准流量比',
    '基准失衡度(%)',
    '基准判级',
    '复测测次日期',
    '复测开度(%)',
    '复测流量(m³/h)',
    '复测室温(℃)',
    '复测流量比',
    '复测失衡度(%)',
    '复测判级',
    '调节依据',
    '复核意见'
  ]
  const formatDateTime = (ms: number | null): string =>
    ms === null ? '—' : new Date(ms).toLocaleString('zh-CN', { hour12: false })
  const num = (value: number | null): string | number => (value === null ? '—' : value)
  const ratioText = (ratio: number, hasReading: boolean): string => (hasReading ? ratio.toFixed(2) : '—')
  const lines: string[] = [header.map(csvCell).join(',')]
  adjusts.forEach((adjust) => {
    const valve = valves.find((item) => item.id === adjust.valveId)
    const building = valve ? buildings.find((item) => item.id === valve.buildingId) ?? null : null
    const station = building ? stations.find((item) => item.id === building.stationId) ?? null : null
    const design = valve ? valve.designFlowM3h : 0
    // 待下发尚未执行时，以当前最新实测预览一次「待执行基准」
    const preview = (() => {
      if (adjust.executionSnapshot) return null
      const own = measures.filter((item) => item.valveId === adjust.valveId).sort((a, b) => a.date.localeCompare(b.date))
      return own.length > 0 ? own[own.length - 1] : null
    })()
    const base = adjust.executionSnapshot
    const retest = adjust.reviewSnapshot
    const previewValue = preview ? imbalance(preview.flowM3h, design, preview.roomTempC) : 0
    lines.push(
      [
        station ? station.name : '—',
        building ? building.name : '—',
        building ? building.heatMode : '—',
        valve ? valve.code : '—',
        valve ? valve.dn : '—',
        valve ? valve.position : '—',
        design,
        adjust.targetOpening,
        adjust.executor,
        adjust.state,
        base ? formatDateTime(adjust.executedAt) : '—',
        base ? base.opening : '—',
        base ? base.date ?? '—' : preview ? preview.date : '—',
        base ? num(base.flowM3h) : preview ? preview.flowM3h : '—',
        base ? num(base.roomTempC) : preview ? preview.roomTempC : '—',
        base ? ratioText(base.ratio, base.flowM3h !== null) : preview ? flowRatio(preview.flowM3h, design).toFixed(2) : '—',
        base ? num(base.imbalanceValue) : preview ? previewValue : '—',
        base ? base.level ?? '—' : preview ? balanceLevel(previewValue, preview.flowM3h, design) : '—',
        retest ? retest.date ?? '—' : '—',
        retest ? retest.opening : '—',
        retest ? num(retest.flowM3h) : '—',
        retest ? num(retest.roomTempC) : '—',
        retest ? ratioText(retest.ratio, retest.flowM3h !== null) : '—',
        retest ? num(retest.imbalanceValue) : '—',
        retest ? retest.level ?? '—' : '—',
        adjust.basis,
        adjust.reviewNote || '—'
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
