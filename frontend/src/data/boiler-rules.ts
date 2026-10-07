import type { EntryRow } from './types'

/**
 * 余热锅炉专项规则：
 * 页面只负责渲染，所有兜底、核算、判异、去重口径都集中在本文件，
 * local-service.ts 负责读写，将来换回后端时把规则原样搬走即可。
 */

/** 登记时缺一不可的关键读数：缺一项整条拦截退回。 */
export const BOILER_REQUIRED_FIELDS = ['主蒸汽压力', '主蒸汽温度'] as const

/** 同一口径：给水流量与排污量都按 t/h 核算。 */
export const BOILER_UNIT = 't/h'
export const FEED_FIELD = '给水流量'
export const BLOWDOWN_FIELD = '排污量'

/** 主蒸汽参数合理区间（常规生活垃圾焚烧余热锅炉中压工况）。 */
export const STEAM_PRESSURE_RANGE: Range = { min: 1.0, max: 6.0, unit: 'MPa' }
export const STEAM_TEMPERATURE_RANGE: Range = { min: 200, max: 450, unit: '℃' }
export const FEED_RANGE: Range = { min: 0, max: 200, unit: BOILER_UNIT }

/** 排污率判定口径：排污量 / 给水流量 ×100%，正常 1%～5%。 */
export const BLOWDOWN_RATE_MIN = 0.01
export const BLOWDOWN_RATE_MAX = 0.05

/** 读数明确读到了、但仪表/链路判定无效的标记，和「压根没填」区分开。 */
export const READ_FAILED = '读取失败'

export type Range = { min: number; max: number; unit: string }

export type BoilerIssue = {
  level: 'missing' | 'failed' | 'abnormal'
  field: string
  label: string
  reason?: string
}

export type BoilerEvaluation = {
  /** 主蒸汽压力/温度缺项的读数，登记时据此整条退回。 */
  blocked: BoilerIssue[]
  /** 给水流量、排污量口径核算出的异常（含缺项/越界/排污率超口径）。 */
  anomalies: BoilerIssue[]
  /** 排污率（0～1），读数不齐时为空。 */
  blowdownRate: number | null
}

function rawText(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value).trim()
}

/** 数值型读数；空串、非数字、「读取失败」都返回 null。 */
export function parseReading(row: EntryRow, field: string): number | null {
  const text = rawText(row, field)
  if (text === '' || text === READ_FAILED) {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function missingIssue(field: string, text: string): BoilerIssue {
  return {
    level: text === READ_FAILED ? 'failed' : 'missing',
    field,
    label: text === READ_FAILED ? `${field}读取失败` : `${field}未填报`,
  }
}

/** 主蒸汽压力或温度缺着 → 点名缺的是哪一项，并区分未填报 / 读取失败。 */
export function checkRequiredReadings(row: EntryRow): BoilerIssue[] {
  const issues: BoilerIssue[] = []
  for (const field of BOILER_REQUIRED_FIELDS) {
    const text = rawText(row, field)
    if (text === '' || text === READ_FAILED) {
      issues.push(missingIssue(field, text))
    }
  }
  return issues
}

function inRange(value: number, range: Range): boolean {
  return value >= range.min && value <= range.max
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

/** 排污率口径：同一份 t/h 口径下，排污量 ÷ 给水流量 ×100%。 */
export function calcBlowdownRate(row: EntryRow): number | null {
  const feed = parseReading(row, FEED_FIELD)
  const blowdown = parseReading(row, BLOWDOWN_FIELD)
  if (feed === null || blowdown === null || feed <= 0) {
    return null
  }
  return blowdown / feed
}

/** 给水流量与排污量按同一口径核算，给出异常读数与判定依据。 */
export function evaluateBoilerRow(row: EntryRow): BoilerEvaluation {
  const blocked = checkRequiredReadings(row)
  const anomalies: BoilerIssue[] = []

  // 主蒸汽参数本身越界也属于异常读数（缺项已在 blocked 中点名，不重复计入）。
  const pressure = parseReading(row, '主蒸汽压力')
  if (pressure !== null && !inRange(pressure, STEAM_PRESSURE_RANGE)) {
    anomalies.push({
      level: 'abnormal',
      field: '主蒸汽压力',
      label: '主蒸汽压力异常',
      reason: `主蒸汽压力 ${pressure}${STEAM_PRESSURE_RANGE.unit} 超出合理区间 ${STEAM_PRESSURE_RANGE.min}～${STEAM_PRESSURE_RANGE.max}${STEAM_PRESSURE_RANGE.unit}`,
    })
  }
  const temperature = parseReading(row, '主蒸汽温度')
  if (temperature !== null && !inRange(temperature, STEAM_TEMPERATURE_RANGE)) {
    anomalies.push({
      level: 'abnormal',
      field: '主蒸汽温度',
      label: '主蒸汽温度异常',
      reason: `主蒸汽温度 ${temperature}${STEAM_TEMPERATURE_RANGE.unit} 超出合理区间 ${STEAM_TEMPERATURE_RANGE.min}～${STEAM_TEMPERATURE_RANGE.max}${STEAM_TEMPERATURE_RANGE.unit}`,
    })
  }

  // 给水流量：缺项点名，越界按 t/h 口径判异。
  const feedText = rawText(row, FEED_FIELD)
  const feed = parseReading(row, FEED_FIELD)
  if (feedText === '' || feedText === READ_FAILED) {
    anomalies.push(missingIssue(FEED_FIELD, feedText))
  } else if (feed === null) {
    anomalies.push({
      level: 'abnormal',
      field: FEED_FIELD,
      label: '给水流量异常',
      reason: `给水流量「${feedText}」不是有效数值，无法按 ${BOILER_UNIT} 口径核算`,
    })
  } else if (!inRange(feed, FEED_RANGE)) {
    anomalies.push({
      level: 'abnormal',
      field: FEED_FIELD,
      label: '给水流量异常',
      reason: `给水流量 ${feed}${BOILER_UNIT} 超出合理区间 0～${FEED_RANGE.max}${BOILER_UNIT}`,
    })
  }

  // 排污量：缺项点名，非数值/负值判异。
  const blowdownText = rawText(row, BLOWDOWN_FIELD)
  const blowdown = parseReading(row, BLOWDOWN_FIELD)
  if (blowdownText === '' || blowdownText === READ_FAILED) {
    anomalies.push(missingIssue(BLOWDOWN_FIELD, blowdownText))
  } else if (blowdown === null || blowdown < 0) {
    anomalies.push({
      level: 'abnormal',
      field: BLOWDOWN_FIELD,
      label: '排污量异常',
      reason: `排污量「${blowdownText}」不是有效非负数值，无法按 ${BOILER_UNIT} 口径核算`,
    })
  }

  // 排污率：两项读数同口径核算，超 1%～5% 给判定依据。
  const rate = calcBlowdownRate(row)
  if (rate !== null) {
    if (rate < BLOWDOWN_RATE_MIN || rate > BLOWDOWN_RATE_MAX) {
      anomalies.push({
        level: 'abnormal',
        field: BLOWDOWN_FIELD,
        label: '排污率异常',
        reason: `给水流量 ${feed}${BOILER_UNIT}、排污量 ${blowdown}${BOILER_UNIT} 同口径核算，排污率 = 排污量÷给水流量 = ${formatRate(rate)}，超出正常范围 ${formatRate(BLOWDOWN_RATE_MIN)}～${formatRate(BLOWDOWN_RATE_MAX)}`,
      })
    }
    if (blowdown !== null && blowdown > (feed as number)) {
      anomalies.push({
        level: 'abnormal',
        field: BLOWDOWN_FIELD,
        label: '排污量异常',
        reason: `排污量 ${blowdown}${BOILER_UNIT} 大于同口径给水流量 ${feed}${BOILER_UNIT}，不符合物料平衡`,
      })
    }
  }

  return { blocked, anomalies, blowdownRate: rate }
}

/** 页面上「数据核验」列的一句话结论：缺项优先，其次异常，再到正常。 */
export function summarizeVerification(row: EntryRow): { tone: 'blocked' | 'abnormal' | 'ok'; text: string } {
  const { blocked, anomalies, blowdownRate } = evaluateBoilerRow(row)
  if (blocked.length > 0) {
    return { tone: 'blocked', text: `退回补录：${blocked.map((item) => item.label).join('、')}` }
  }
  if (anomalies.length > 0) {
    const rateTip = blowdownRate !== null ? `（排污率 ${formatRate(blowdownRate)}）` : ''
    return { tone: 'abnormal', text: `异常读数 ${anomalies.length} 项${rateTip}：${anomalies.map((item) => item.label).join('、')}` }
  }
  const rateText = blowdownRate !== null ? `，排污率 ${formatRate(blowdownRate)}` : ''
  return { tone: 'ok', text: `读数齐全、核算正常${rateText}` }
}

/**
 * 同一台锅炉的读数重复登记只记一次，以最后一版为准：
 * 同锅炉编号、同记录时间视为同一读数；版本号大的覆盖小的，
 * 版本相同（旧数据）以排在后面的登记为准。
 */
export function dedupeBoilerRows(rows: EntryRow[]): EntryRow[] {
  const latest = new Map<string, { row: EntryRow; order: number }>()
  rows.forEach((row, order) => {
    const boilerNo = String(row['锅炉编号'] ?? '').trim()
    const recordedAt = String(row['记录时间'] ?? '').trim()
    if (boilerNo === '') {
      // 没有锅炉编号无法判定重复，原样保留并给唯一键，避免互相覆盖。
      latest.set(`__noboiler__:${order}`, { row, order })
      return
    }
    const key = `${boilerNo}|${recordedAt}`
    const existed = latest.get(key)
    if (!existed) {
      latest.set(key, { row, order })
      return
    }
    const oldVersion = Number(existed.row['版本'] ?? 1)
    const newVersion = Number(row['版本'] ?? 1)
    const takeNew =
      Number.isFinite(newVersion) && Number.isFinite(oldVersion)
        ? newVersion >= oldVersion
        : order >= existed.order
    if (takeNew) {
      latest.set(key, { row, order })
    }
  })
  return [...latest.values()]
    .sort((a, b) => (Number(b.row.id) - Number(a.row.id)) || b.order - a.order)
    .map((item) => item.row)
}

/** 取数后统一过一遍：去重保最后一版，按规则重算异常标记。 */
export function normalizeBoilerRows(rows: EntryRow[]): EntryRow[] {
  return dedupeBoilerRows(rows).map((row) => {
    const { blocked, anomalies } = evaluateBoilerRow(row)
    return {
      ...row,
      abnormal: row.abnormal === true || anomalies.length > 0,
      // 关键读数被拦的记录保留可见（退回需点名），但不能再当在运记录流转。
      blocked: blocked.length > 0,
    }
  })
}

export function describeBlowdownRate(rate: number | null): string {
  if (rate === null) {
    return '读数不齐，无法核算'
  }
  return `${formatRate(rate)}（正常范围 ${formatRate(BLOWDOWN_RATE_MIN)}～${formatRate(BLOWDOWN_RATE_MAX)}）`
}
