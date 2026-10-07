import {
  BLOWDOWN_FIELD,
  BOILER_REQUIRED_FIELDS,
  BOILER_UNIT,
  FEED_FIELD,
  READ_FAILED,
  calcBlowdownRate,
  describeBlowdownRate,
  evaluateBoilerRow,
  normalizeBoilerRows,
  summarizeVerification,
} from '@/data/boiler-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  appendLegacyEntry,
  listLegacyEntries,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  LegacyEntry,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// —— 余热锅炉专项：取数兜底、登记拦截、同口径核算、去重、判异留痕 ——

export type BoilerFetchResult =
  | { ok: true; items: EntryRow[]; total: number }
  | { ok: false; message: string; partial: boolean }

export type BoilerFailureMode = 'offline' | 'partial'

// 一次性故障开关：置位后下一次取数必失败，重试时自动解除，页面上的「再试一次」真的能取到。
let pendingFailure: BoilerFailureMode | null = null

/** 模拟链路故障：offline 取数失败，partial 读到一半断开。 */
export function armBoilerFailure(mode: BoilerFailureMode): void {
  pendingFailure = mode
}

/** 取数结束后把已规范化（去重、判异）的结果落库，保证清单与各处显示同一份数据。 */
function commitBoilerRows(rows: EntryRow[]): EntryRow[] {
  const normalized = normalizeBoilerRows(rows)
  saveRows('boiler', normalized)
  return normalized
}

function fetchDelay(ms: number): Promise<void> {
  // 浏览器里即 window.setTimeout，node 测试环境用全局 setTimeout。
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

/**
 * 拉取余热锅炉清单：
 * - 正常时统一走 normalize（去重保最后一版、按口径重算异常）；
 * - 取数失败 / 读到一半断开时返回失败信息，页面给提示并支持再试一次；
 * - 无论卡片、图例还是表格，都只用本函数成功返回的同一份 items。
 */
export async function fetchBoilerEntries(
  filters: Record<string, string> = {},
): Promise<BoilerFetchResult> {
  await fetchDelay(300)
  const failure = pendingFailure
  pendingFailure = null
  if (failure === 'offline') {
    return { ok: false, message: '余热锅炉读数取数失败：与采集链路连接中断，请检查后再试一次', partial: false }
  }

  let rows: EntryRow[] = listRows('boiler')
  if (failure === 'partial') {
    // 读到一半断掉：只拿到前半截数据时不能当全量渲染，明确报「读取中断」。
    rows = rows.slice(0, Math.max(1, Math.ceil(rows.length / 2)))
    if (rows.length === 0) {
      return { ok: false, message: '余热锅炉读数读取中断：一条都没读到，请再试一次', partial: true }
    }
    return {
      ok: false,
      message: `余热锅炉读数读取中断：仅读到 ${rows.length} 条，剩余记录未取完，请再试一次取全量`,
      partial: true,
    }
  }

  const normalized = commitBoilerRows(rows)
  const matched = filterRows(normalized, filters)
  return { ok: true, items: matched, total: matched.length }
}

export type BoilerCreateInput = {
  boilerNo: string
  pressure: string
  temperature: string
  feed: string
  blowdown: string
  shift: string
  recordedAt: string
  operator: string
}

export type BoilerCreateResult =
  | { ok: true; message: string; row: EntryRow }
  | { ok: false; message: string; missing?: string[] }

function nextBoilerId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/**
 * 登记锅炉读数：
 * 主蒸汽压力或温度缺着（未填报 / 读取失败）整条拦下并退回，点名缺的是哪一项；
 * 同一台锅炉同一时刻重复登记只记一次，以最后一版为准。
 */
export function registerBoilerEntry(input: BoilerCreateInput): BoilerCreateResult {
  const missing: string[] = []
  for (const field of BOILER_REQUIRED_FIELDS) {
    const value = field === '主蒸汽压力' ? input.pressure : input.temperature
    const text = value.trim()
    if (text === '') {
      missing.push(`${field}（未填报）`)
    } else if (text === READ_FAILED) {
      missing.push(`${field}（读取失败）`)
    } else if (!Number.isFinite(Number(text))) {
      return { ok: false, message: `${field}「${text}」不是有效数值，请录入读数后再提交` }
    }
  }
  if (input.boilerNo.trim() === '') {
    missing.unshift('锅炉编号（未填报）')
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `登记被退回：${missing.join('、')}；关键读数缺项的记录不能入库`,
      missing,
    }
  }

  for (const [field, value] of [
    [FEED_FIELD, input.feed],
    [BLOWDOWN_FIELD, input.blowdown],
  ] as const) {
    const text = value.trim()
    if (text !== '' && text !== READ_FAILED && !Number.isFinite(Number(text))) {
      return { ok: false, message: `${field}「${text}」不是有效数值，无法按 ${BOILER_UNIT} 口径核算` }
    }
  }

  const rows = listRows('boiler')
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  const existedIndex = rows.findIndex(
    (row) =>
      String(row['锅炉编号'] ?? '').trim() === input.boilerNo.trim() &&
      String(row['记录时间'] ?? '').trim() === input.recordedAt.trim(),
  )

  const draft: EntryRow = {
    id: existedIndex >= 0 ? rows[existedIndex].id : nextBoilerId(rows),
    status: existedIndex >= 0 ? rows[existedIndex].status : '运行中',
    pending: true,
    abnormal: false,
    锅炉编号: input.boilerNo.trim(),
    主蒸汽压力: input.pressure.trim(),
    主蒸汽温度: input.temperature.trim(),
    给水流量: input.feed.trim(),
    排污量: input.blowdown.trim(),
    运行班次: input.shift.trim(),
    记录时间: input.recordedAt.trim(),
    锅炉状态: existedIndex >= 0 ? rows[existedIndex]['锅炉状态'] ?? '运行中' : '运行中',
    版本: existedIndex >= 0 ? Number(rows[existedIndex]['版本'] ?? 1) + 1 : 1,
    登记人: input.operator,
    登记时间: stamp,
  }
  const { anomalies } = evaluateBoilerRow(draft)
  draft.abnormal = anomalies.length > 0
  if (anomalies.length > 0) {
    // 新版读数重新核算后，旧的人工批复不再适用，清掉旧留痕字段（台账历史仍保留）。
    draft['判异人'] = ''
    draft['判异时间'] = ''
    draft['判异意见'] = ''
    draft['判异依据'] = ''
  }

  let nextRows: EntryRow[]
  let message: string
  if (existedIndex >= 0) {
    nextRows = rows.map((row, index) => (index === existedIndex ? draft : row))
    message = `锅炉 ${input.boilerNo.trim()} 在 ${input.recordedAt.trim()} 的读数已重复登记，只保留最后一版（v${draft['版本']}）`
  } else {
    nextRows = [...rows, draft]
    message = `锅炉 ${input.boilerNo.trim()} 的读数已登记（v1）`
  }
  if (anomalies.length > 0) {
    message += `；系统按口径标出 ${anomalies.length} 项异常读数，需人工批复`
  }

  commitBoilerRows(nextRows)
  return { ok: true, message, row: draft }
}

export type BoilerDecisionResult =
  | { ok: true; message: string; legacy: LegacyEntry }
  | { ok: false; message: string }

function nextLegacyId(): number {
  return listLegacyEntries().reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

/**
 * 判定异常的批复：回写到锅炉记录本身，同时进值班交接遗留台账，
 * 记录判定依据、意见、谁、什么时候改的，可倒查。
 */
export function decideBoilerAbnormal(
  id: number,
  params: { abnormal: boolean; opinion: string; operator: string; shiftLabel: string },
): BoilerDecisionResult {
  const rows = listRows('boiler')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的余热锅炉记录` }
  }
  const current = rows[index]
  const { blocked, anomalies } = evaluateBoilerRow(current)
  const anomalyBasis = anomalies.map((item) => item.reason ?? item.label)
  if (params.abnormal && blocked.length > 0) {
    return {
      ok: false,
      message: '关键读数（主蒸汽压力/温度）缺失，需先补录读数后再批复异常',
    }
  }

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const opinion = params.opinion.trim() || (params.abnormal ? '判定异常，列入遗留跟踪' : '复核读数正常，解除异常标记')

  const updated: EntryRow = {
    ...current,
    // 系统按口径仍核算出异常时，即使人工解除，异常读数标记也保留（批复意见另行留痕）。
    abnormal: anomalies.length > 0 ? true : params.abnormal,
    判异结果: params.abnormal ? '判定异常' : anomalies.length > 0 ? '人工解除·系统仍判异' : '解除异常',
    判异依据: params.abnormal || anomalies.length > 0 ? anomalyBasis.join('；') : '',
    判异意见: opinion,
    判异人: params.operator,
    判异时间: stamp,
  }
  const nextRows = rows.map((row, rowIndex) => (rowIndex === index ? updated : row))
  commitBoilerRows(nextRows)

  const legacy: LegacyEntry = {
    id: nextLegacyId(),
    module: 'boiler',
    sourceId: id,
    boilerNo: String(current['锅炉编号'] ?? ''),
    recordedAt: String(current['记录时间'] ?? ''),
    basis: params.abnormal
      ? anomalyBasis.length > 0
        ? anomalyBasis
        : ['人工复核判定异常']
      : anomalies.length > 0
        ? ['人工复核解除异常标记，但系统按口径仍判定异常', ...anomalyBasis]
        : ['人工复核解除异常：读数核算正常'],
    opinion,
    operator: params.operator,
    shiftLabel: params.shiftLabel,
    action: params.abnormal ? '判定异常' : '解除异常',
    decidedAt: stamp,
  }
  appendLegacyEntry(legacy)

  return {
    ok: true,
    message: params.abnormal
      ? `已判定锅炉 ${legacy.boilerNo} 读数异常，批复已回写值班交接遗留台账（${params.operator} · ${stamp}）`
      : `已解除锅炉 ${legacy.boilerNo} 的异常标记，处理结果已回写值班交接遗留台账`,
    legacy,
  }
}

/** 值班交接遗留台账：当前只接锅炉判异批复，按时间倒序。 */
export function loadShiftLegacy(): LegacyEntry[] {
  return listLegacyEntries()
}

// 给页面/其他模块核算排污率时复用同一口径，避免两处对不上。
export { calcBlowdownRate, describeBlowdownRate, summarizeVerification }
