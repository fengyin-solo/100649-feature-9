import { normalizeBoilerRows } from './boiler-rules'
import { SEED_ROWS } from './seed'
import type { EntryRow, LegacyEntry } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：锅炉示例数据换成真实读数口径，旧缓存自动重新播种。
const STORAGE_KEY = 'waste-to-energy-plant:entries:v2'
const LEGACY_KEY = 'waste-to-energy-plant:shift-legacy:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    // 锅炉读数统一过规则：去重保最后一版、按同口径重算异常，概览页与锅炉页看到的才一致。
    if (Array.isArray(merged.boiler)) {
      merged.boiler = normalizeBoilerRows(merged.boiler)
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// —— 值班交接遗留台账：独立于业务清单，专门留痕跨模块批复 ——

function readLegacy(): LegacyEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(LEGACY_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LegacyEntry[]) : []
  } catch {
    return []
  }
}

let legacyCache: LegacyEntry[] | null = null

export function listLegacyEntries(): LegacyEntry[] {
  if (legacyCache === null) {
    legacyCache = readLegacy()
  }
  return legacyCache
}

export function appendLegacyEntry(entry: LegacyEntry): LegacyEntry[] {
  // 新批复排在最前，台账按时间倒序可倒查。
  const next = [entry, ...listLegacyEntries()]
  legacyCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(next))
  }
  return next
}

export function legacyStorageKey(): string {
  return LEGACY_KEY
}
