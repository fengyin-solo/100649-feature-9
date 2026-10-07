<template>
  <section class="page" data-module="shift">
    <header class="page-head">
      <div>
        <h2>值班交接班管理</h2>
        <p class="page-desc">维护交接班记录，围绕交接编号、值班班组、班次、交班人员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记交接班记录</button>
        <button class="btn" type="button" @click="exportRows">导出值班交接班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无值班交接班数据，可先登记交接班记录</td>
        </tr>
      </tbody>
    </table>

    <section class="legacy-section">
      <header class="legacy-head">
        <h3>值班交接遗留台账</h3>
        <button class="btn ghost" type="button" @click="reloadLegacy">刷新台账</button>
      </header>
      <p class="page-desc">余热锅炉判异批复在此回写留痕：判定依据、批复意见、谁在什么时候改的都可倒查。</p>
      <table v-if="legacyRows.length" class="data-table legacy-table">
        <thead>
          <tr>
            <th>批复时间</th>
            <th>来源记录</th>
            <th>锅炉编号</th>
            <th>读数时间</th>
            <th>处理结果</th>
            <th>判定依据</th>
            <th>批复意见</th>
            <th>批复人</th>
            <th>班次</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in legacyRows" :key="String(item.id)">
            <td>{{ item.decidedAt }}</td>
            <td>{{ moduleName(item.module) }} #{{ item.sourceId }}</td>
            <td>{{ item.boilerNo }}</td>
            <td>{{ item.recordedAt }}</td>
            <td><span class="verify-tag" :class="item.action === '判定异常' ? 'tag-abnormal' : 'tag-ok'">{{ item.action }}</span></td>
            <td class="legacy-basis">
              <ul class="reason-list">
                <li v-for="(basis, idx) in item.basis" :key="idx">{{ basis }}</li>
              </ul>
            </td>
            <td>{{ item.opinion }}</td>
            <td>{{ item.operator }}</td>
            <td>{{ item.shiftLabel }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="state-panel">
        <strong>暂无记录</strong>
        <p class="state-sub">遗留台账暂时一条都没有：锅炉异常读数完成判异批复后，会自动回写到这里。</p>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条值班交接班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  loadShiftLegacy,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { MODULE_BY_KEY } from '@/data/modules'
import type { EntryRow, LegacyEntry } from '@/data/types'

const meta = moduleMeta('shift')
const columns = ["交接编号", "值班班组", "班次", "交班人员", "接班人员", "交接事项", "交接时间", "交接状态"]
const actions = ["发起交接", "确认交接", "登记遗留"]
const statuses = ["待交接", "交接中", "已交接", "有遗留"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const legacyRows = ref<LegacyEntry[]>([])

const stats = computed(() => [
  { label: "待交接班次", value: rows.value.filter((row) => String(row.status) === "待交接").length },
  { label: "已交接班次", value: rows.value.filter((row) => String(row.status) === "已交接").length },
  { label: "有遗留事项", value: legacyRows.value.filter((item) => item.action === '判定异常').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function moduleName(key: string): string {
  return MODULE_BY_KEY.get(key)?.name ?? key
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '交接班记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reloadLegacy() {
  legacyRows.value = loadShiftLegacy()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadLegacy()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值班交接班列表读取失败'
  }
}

onMounted(reload)
</script>
