import type { EntryRow } from '@/data/types'

// 余热锅炉领域逻辑：必填校验、给水/排污同口径核算、重复登记去重、异常判定与批复。
// 纯函数 + 本地持久化，换回后端时这一层可整体替换成接口调用。

export const BOILER_KEY = 'boiler'

export const FIELD_ID = '锅炉编号'
export const FIELD_PRESSURE = '主蒸汽压力'
export const FIELD_TEMPERATURE = '主蒸汽温度'
export const FIELD_FEED = '给水流量'
export const FIELD_BLOWDOWN = '排污量'
export const FIELD_SHIFT = '运行班次'
export const FIELD_TIME = '记录时间'

// 必填项：缺了这两项的整条记录要在登记口拦下来。
export const REQUIRED_FIELDS = [FIELD_PRESSURE, FIELD_TEMPERATURE] as const

// 同一份核算口径：排污率 = 排污量 / 给水流量 × 100%，单位统一折算成 t/h。
export const BLOWDOWN_RATE_MIN = 2 // 连续排污率正常下限（%）
export const BLOWDOWN_RATE_MAX = 10 // 连续排污率正常上限（%）

export type ReadingKind = 'ok' | 'blank' | 'unreadable'

export type NumericReading = {
  value: number | null
  kind: ReadingKind
  raw: string
}

export type AccountingVerdict = {
  feed: NumericReading
  blowdown: NumericReading
  rate: number | null // 排污率（%）
  abnormal: boolean
  reason: string
}

export type BoilerSnapshot = EntryRow & {
  pressure: NumericReading
  temperature: NumericReading
  incomplete: boolean
  missingFields: string[]
  accounting: AccountingVerdict
}

export type RegisterInput = {
  boilerId: string
  pressure: string
  temperature: string
  feed: string
  blowdown: string
  shift: string
  recordedAt: string
}

export type RegisterOutcome =
  | { ok: true; message: string; replaced: boolean }
  | { ok: false; message: string }

type RawVerdict = {
  decision: 'confirmed' | 'dismissed'
  comment: string
  reviewer: string
  time: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function asBoilerVerdict(value: unknown): RawVerdict | null {
  if (!isObject(value)) return null
  if (value.decision !== 'confirmed' && value.decision !== 'dismissed') return null
  return {
    decision: value.decision,
    comment: String(value.comment ?? ''),
    reviewer: String(value.reviewer ?? ''),
    time: String(value.time ?? ''),
  }
}

// 读数解析：空串=还没填；数字外的文本（采集失败、--、乱码等）=读不出来。
export function parseReading(raw: unknown): NumericReading {
  const text = String(raw ?? '').trim()
  if (text === '') return { value: null, kind: 'blank', raw: '' }
  const matched = text.match(/-?\d+(?:\.\d+)?/)
  const value = matched ? Number(matched[0]) : NaN
  if (!Number.isFinite(value)) return { value: null, kind: 'unreadable', raw: text }
  return { value, kind: 'ok', raw: text }
}

// 给水流量与排污量按同一份口径核算：先都按 t/h 取值，再算排污率并给出判定依据。
export function accountFlows(feedRaw: unknown, blowdownRaw: unknown): AccountingVerdict {
  const feed = parseReading(feedRaw)
  const blowdown = parseReading(blowdownRaw)

  if (feed.kind === 'unreadable' || blowdown.kind === 'unreadable') {
    const bad = feed.kind === 'unreadable' ? FIELD_FEED : FIELD_BLOWDOWN
    return {
      feed,
      blowdown,
      rate: null,
      abnormal: true,
      reason: `${bad}读数无法识别（原始值「${bad === FIELD_FEED ? feed.raw : blowdown.raw}」），无法按同一口径核算排污率`,
    }
  }
  if (feed.kind === 'blank' || blowdown.kind === 'blank') {
    const missing = feed.kind === 'blank' ? FIELD_FEED : FIELD_BLOWDOWN
    return {
      feed,
      blowdown,
      rate: null,
      abnormal: false,
      reason: `${missing}未填报，排污率暂不核算`,
    }
  }

  const feedValue = feed.value as number
  const blowdownValue = blowdown.value as number
  if (feedValue < 0 || blowdownValue < 0) {
    return {
      feed,
      blowdown,
      rate: null,
      abnormal: true,
      reason: `给水流量、排污量读数不应为负数（给水 ${feedValue} t/h、排污 ${blowdownValue} t/h）`,
    }
  }
  if (feedValue === 0) {
    return {
      feed,
      blowdown,
      rate: null,
      abnormal: blowdownValue > 0,
      reason:
        blowdownValue > 0
          ? `给水流量为 0 t/h 却有排污 ${blowdownValue} t/h，两份读数对不上`
          : '给水流量为 0 t/h，排污率不参与核算',
    }
  }

  const rate = (blowdownValue / feedValue) * 100
  const outOfRange = rate < BLOWDOWN_RATE_MIN || rate > BLOWDOWN_RATE_MAX
  return {
    feed,
    blowdown,
    rate,
    abnormal: outOfRange,
    reason: outOfRange
      ? `排污率 = ${blowdownValue} ÷ ${feedValue} × 100% = ${rate.toFixed(2)}%，超出 ${BLOWDOWN_RATE_MIN}%~${BLOWDOWN_RATE_MAX}% 正常区间`
      : `排污率 = ${blowdownValue} ÷ ${feedValue} × 100% = ${rate.toFixed(2)}%，处于 ${BLOWDOWN_RATE_MIN}%~${BLOWDOWN_RATE_MAX}% 正常区间`,
  }
}

export function missingRequired(row: Partial<EntryRow>): string[] {
  return REQUIRED_FIELDS.filter((field) => String(row[field] ?? '').trim() === '')
}

export function snapshotFor(row: EntryRow): BoilerSnapshot {
  const pressure = parseReading(row[FIELD_PRESSURE])
  const temperature = parseReading(row[FIELD_TEMPERATURE])
  const missingFields: string[] = []
  if (pressure.kind === 'blank') missingFields.push(FIELD_PRESSURE)
  if (temperature.kind === 'blank') missingFields.push(FIELD_TEMPERATURE)
  return {
    ...row,
    pressure,
    temperature,
    incomplete: missingFields.length > 0,
    missingFields,
    accounting: accountFlows(row[FIELD_FEED], row[FIELD_BLOWDOWN]),
  }
}

export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${rate.toFixed(2)}%`
}

function clean(text: string): string {
  return text.trim()
}

export function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 登记：必填项缺失整条拦下并点名；同一台锅炉重复登记只保留最后一版。
export function registerBoiler(
  rows: EntryRow[],
  input: RegisterInput,
  operator: string,
): { rows: EntryRow[]; outcome: RegisterOutcome } {
  const boilerId = clean(input.boilerId)
  if (!boilerId) {
    return { rows, outcome: { ok: false, message: `锅炉编号不能为空，请补齐后再提交` } }
  }

  const draft: Partial<EntryRow> = {
    [FIELD_ID]: boilerId,
    [FIELD_PRESSURE]: clean(input.pressure),
    [FIELD_TEMPERATURE]: clean(input.temperature),
    [FIELD_FEED]: clean(input.feed),
    [FIELD_BLOWDOWN]: clean(input.blowdown),
    [FIELD_SHIFT]: clean(input.shift),
    [FIELD_TIME]: clean(input.recordedAt),
  }

  const missing = missingRequired(draft)
  if (missing.length > 0) {
    return {
      rows,
      outcome: {
        ok: false,
        message: `登记被退回：锅炉 ${boilerId} 的${missing.join('、')}缺着，整条记录不予登记，请补齐后重新提交`,
      },
    }
  }

  const accounting = accountFlows(draft[FIELD_FEED], draft[FIELD_BLOWDOWN])
  const stamp = nowText()
  const existingIndex = rows.findIndex((row) => String(row[FIELD_ID]) === boilerId)
  const replaced = existingIndex >= 0

  const base: EntryRow = {
    id: replaced ? rows[existingIndex].id : rows.length + 1,
    status: replaced ? rows[existingIndex].status : '待投运',
    pending: true,
    abnormal: accounting.abnormal,
    [FIELD_ID]: boilerId,
    [FIELD_PRESSURE]: String(draft[FIELD_PRESSURE] ?? ''),
    [FIELD_TEMPERATURE]: String(draft[FIELD_TEMPERATURE] ?? ''),
    [FIELD_FEED]: String(draft[FIELD_FEED] ?? ''),
    [FIELD_BLOWDOWN]: String(draft[FIELD_BLOWDOWN] ?? ''),
    [FIELD_SHIFT]: String(draft[FIELD_SHIFT] ?? ''),
    [FIELD_TIME]: String(draft[FIELD_TIME] ?? '') || stamp,
    登记人员: operator,
    最后修改人: operator,
    最后修改时间: stamp,
    排污率: formatRate(accounting.rate),
    核算依据: accounting.reason,
  }

  // 重新登记以最后一版为准：清掉旧批复，避免新读数挂着旧结论。
  const nextRow = snapshotToRow(snapshotFor(base))
  const next = [...rows]
  if (replaced) {
    next[existingIndex] = nextRow
  } else {
    next.push(nextRow)
  }

  return {
    rows: next,
    outcome: {
      ok: true,
      replaced,
      message: replaced
        ? `锅炉 ${boilerId} 已有登记，已按最后一版覆盖（同一台锅炉只保留一条）；核算结论：${accounting.reason}`
        : `锅炉 ${boilerId} 登记成功；核算结论：${accounting.reason}`,
    },
  }
}

// 把核算快照回写到行上；若此前已有批复，维持批复结论，不被重新核算冲掉。
export function snapshotToRow(snap: BoilerSnapshot): EntryRow {
  const {
    pressure: _pressure,
    temperature: _temperature,
    incomplete: _incomplete,
    missingFields: _missingFields,
    accounting,
    ...row
  } = snap
  const verdict = asBoilerVerdict(row['判定批复'])
  const abnormal = verdict
    ? verdict.decision === 'confirmed'
    : accounting.abnormal || row.abnormal === true
  return {
    ...row,
    abnormal,
    排污率: formatRate(accounting.rate),
    核算依据: accounting.reason ?? '',
  }
}

export type VerdictDecision = 'confirmed' | 'dismissed'

export type VerdictResult = {
  rows: EntryRow[]
  ledgerEntry: {
    event: string
    boilerId: string
    basis: string
    rate: string
    decision: VerdictDecision
    comment: string
    reviewer: string
    time: string
  }
  message: string
}

// 异常判定批复：确认异常或解除异常，结论回写记录，并生成一条可倒查的遗留台账。
export function applyBoilerVerdict(
  rows: EntryRow[],
  id: number,
  decision: VerdictDecision,
  comment: string,
  reviewer: string,
): VerdictResult | null {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return null

  const time = nowText()
  const verdict: RawVerdict = { decision, comment: comment.trim(), reviewer, time }
  const snap = snapshotFor(rows[index])
  const updated: EntryRow = {
    ...snapshotToRow(snap),
    abnormal: decision === 'confirmed',
    pending: decision === 'confirmed',
    判定批复: verdict,
    判定人: reviewer,
    判定时间: time,
    判定意见: comment.trim(),
  }

  const next = [...rows]
  next[index] = updated

  return {
    rows: next,
    ledgerEntry: {
      event: decision === 'confirmed' ? '锅炉异常判定批复：确认异常' : '锅炉异常判定批复：解除异常',
      boilerId: String(updated[FIELD_ID] ?? ''),
      basis: snap.accounting.reason,
      rate: formatRate(snap.accounting.rate),
      decision,
      comment: comment.trim(),
      reviewer,
      time,
    },
    message:
      decision === 'confirmed'
        ? `锅炉 ${updated[FIELD_ID]} 已判定为异常，批复已回写值班交接遗留台账`
        : `锅炉 ${updated[FIELD_ID]} 异常已解除，解除批复已回写值班交接遗留台账`,
  }
}

// 状态流转仍走通用动作，但要保住锅炉线自己的核算字段与异常结论。
export function withBoilerStatus(row: EntryRow, status: string, statuses: string[]): EntryRow {
  const snap = snapshotFor(row)
  const verdict = asBoilerVerdict(row['判定批复'])
  const abnormal = verdict ? verdict.decision === 'confirmed' : snap.accounting.abnormal
  return {
    ...snapshotToRow(snap),
    status,
    pending: status !== statuses[statuses.length - 1],
    abnormal,
  }
}
