import {
  applyBoilerVerdict,
  BOILER_KEY,
  registerBoiler,
  snapshotFor,
  withBoilerStatus,
  type BoilerSnapshot,
  type RegisterInput,
  type VerdictDecision,
} from '@/data/boiler-domain'
import { listRows, saveRows } from '@/data/local-store'
import { moduleMeta } from '@/api/local-service'
import { appendLegacyLedger } from '@/data/legacy-ledger'
import type { EntryRow } from '@/data/types'

// 锅炉线自己的取数口：模拟网络读取（延迟 + 可能失败/读到一半断掉），
// 页面据此给出失败提示和「再试一次」。成功后列表、统计、图例都用同一份快照，保证对得上。

let pendingFailures = 0

// 演示用：让下一次取数失败（取数失败 / 读到一半断掉）。
export function armNextLoadFailure(): void {
  pendingFailures += 1
}

export type BoilerPage = {
  items: BoilerSnapshot[]
  total: number
  stats: { label: string; value: number }[]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

// 读到一半断掉：记录缺字段或行结构损坏时直接判失败，绝不把半截数据端给页面。
function assertIntact(rows: EntryRow[]): void {
  if (!Array.isArray(rows)) {
    throw new Error('余热锅炉数据读到一半断掉：返回内容不是记录列表，请重试')
  }
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || typeof row.id === 'undefined') {
      throw new Error('余热锅炉数据读到一半断掉：存在残缺行，请重试')
    }
  }
}

export async function fetchBoilerEntries(
  filters: Record<string, string> = {},
): Promise<BoilerPage> {
  await delay(350)
  if (pendingFailures > 0) {
    pendingFailures -= 1
    throw new Error('余热锅炉记录取数失败：与本地数据源的连接中断，请检查后再试一次')
  }

  let rows: EntryRow[]
  try {
    rows = listRows(BOILER_KEY)
    assertIntact(rows)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('余热锅炉')) throw error
    throw new Error('余热锅炉记录读取失败，请再试一次')
  }

  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const snapshots = rows.map(snapshotFor).filter((snap) =>
    pairs.every(([field, value]) => String(snap[field] ?? '').includes(value.trim())),
  )

  return {
    items: snapshots,
    total: snapshots.length,
    stats: buildStats(snapshots),
  }
}

function buildStats(items: BoilerSnapshot[]): { label: string; value: number }[] {
  const count = (status: string) => items.filter((item) => item.status === status).length
  return [
    { label: '运行中锅炉', value: count('运行中') },
    { label: '已停运锅炉', value: count('已停运') },
    { label: '检修中锅炉', value: count('检修中') },
    { label: '待批复异常', value: items.filter((item) => item.accounting.abnormal && !item['判定批复']).length },
    { label: '资料不全', value: items.filter((item) => item.incomplete).length },
  ]
}

export function submitBoilerEntry(input: RegisterInput, operator: string) {
  const { rows, outcome } = registerBoiler(listRows(BOILER_KEY), input, operator)
  if (outcome.ok) saveRows(BOILER_KEY, rows)
  return outcome
}

export function verdictBoilerEntry(
  id: number,
  decision: VerdictDecision,
  comment: string,
  operator: string,
): string | null {
  const result = applyBoilerVerdict(listRows(BOILER_KEY), id, decision, comment, operator)
  if (!result) return null
  saveRows(BOILER_KEY, result.rows)
  // 批复同步回写到值班交接的遗留台账：事件、依据、批复人、时间齐全，可倒查。
  appendLegacyLedger(result.ledgerEntry)
  return result.message
}

export function changeBoilerStatus(id: number, action: string): string | null {
  const meta = moduleMeta(BOILER_KEY)
  const target = meta.actionTargets[action]
  if (!target) return `${meta.entity}没有登记「${action}」这个动作`
  const rows = listRows(BOILER_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return `没有找到编号为 ${id} 的${meta.entity}`

  const current = rows[index]
  if (String(current.status) === target) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  const next = [...rows]
  next[index] = withBoilerStatus(current, target, meta.statuses)
  saveRows(BOILER_KEY, next)
  return `${meta.entity}已${action}，当前状态「${target}」`
}
