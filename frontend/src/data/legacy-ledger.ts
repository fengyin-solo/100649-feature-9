// 值班交接遗留台账：只追加、不改写，谁在什么时候批复了哪台锅炉的异常都能倒查。
// 与业务记录分开存，避免重置模块数据时把批复痕迹抹掉。

export type LegacyLedgerEntry = {
  id: number
  event: string
  boilerId: string
  basis: string
  rate: string
  decision: 'confirmed' | 'dismissed'
  comment: string
  reviewer: string
  time: string
}

const LEDGER_KEY = 'waste-to-energy-plant:shift-legacy-ledger'
const SEED_LEDGER: LegacyLedgerEntry[] = [
  {
    id: 1,
    event: '锅炉异常判定批复：确认异常',
    boilerId: 'BOIL-0004',
    basis: '排污率 = 4.00 ÷ 24.00 × 100% = 16.67%，超出 2%~10% 正常区间',
    rate: '16.67%',
    decision: 'confirmed',
    comment: '排污阀开度异常，已通知检修班核对，列入下一班遗留事项',
    reviewer: '值班管理员',
    time: '2026-10-05 09:20',
  },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readLedger(): LegacyLedgerEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_LEDGER)
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    const seeded = clone(SEED_LEDGER)
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LegacyLedgerEntry[]) : clone(SEED_LEDGER)
  } catch {
    return clone(SEED_LEDGER)
  }
}

let cache: LegacyLedgerEntry[] | null = null

export function listLegacyLedger(): LegacyLedgerEntry[] {
  if (cache === null) {
    cache = readLedger()
  }
  return cache
}

export function appendLegacyLedger(
  entry: Omit<LegacyLedgerEntry, 'id'>,
): LegacyLedgerEntry[] {
  const next = [...listLegacyLedger(), { ...entry, id: listLegacyLedger().length + 1 }]
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(next))
  }
  return next
}
