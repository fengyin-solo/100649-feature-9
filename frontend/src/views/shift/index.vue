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

    <footer class="page-foot">
      <span>共 {{ total }} 条值班交接班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="ledger">
      <header class="ledger-head">
        <div>
          <h3>值班交接遗留台账</h3>
          <p class="page-desc">余热锅炉读数异常的判定批复会回写到这里，只追加不改写，谁、什么时候、按什么依据改判都可倒查。</p>
        </div>
        <button class="btn" type="button" @click="reloadLedger">刷新台账</button>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>批复事件</th>
            <th>锅炉编号</th>
            <th>判定排污率</th>
            <th>判定依据</th>
            <th>批复意见</th>
            <th>批复人</th>
            <th>批复时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledger" :key="entry.id" :class="{ 'row-dismissed': entry.decision === 'dismissed' }">
            <td>{{ entry.id }}</td>
            <td>
              <span class="tag" :class="entry.decision === 'confirmed' ? 'tag-abnormal' : 'tag-ok'">
                {{ entry.decision === 'confirmed' ? '确认异常' : '解除异常' }}
              </span>
              {{ entry.event.replace(/^锅炉异常判定批复：/, '') }}
            </td>
            <td>{{ entry.boilerId }}</td>
            <td>{{ entry.rate }}</td>
            <td class="basis-cell">{{ entry.basis }}</td>
            <td>{{ entry.comment }}</td>
            <td>{{ entry.reviewer }}</td>
            <td>{{ entry.time }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td colspan="8" class="empty-state">暂无遗留台账记录</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listLegacyLedger, type LegacyLedgerEntry } from '@/data/legacy-ledger'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('shift')
const columns = ["交接编号", "值班班组", "班次", "交班人员", "接班人员", "交接事项", "交接时间", "交接状态"]
const actions = ["发起交接", "确认交接", "登记遗留"]
const statuses = ["待交接", "交接中", "已交接", "有遗留"]
const stats = [{"label": "待交接班次", "value": 0}, {"label": "已交接班次", "value": 0}, {"label": "有遗留事项", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const ledger = ref<LegacyLedgerEntry[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function reloadLedger() {
  // 台账只追加：最新批复在最后，倒序展示，先看到最近一次谁改的。
  ledger.value = [...listLegacyLedger()].sort((a, b) => b.id - a.id)
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值班交接班列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadLedger()
})
</script>

<style scoped>
.ledger { margin-top: 24px; }
.ledger-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.ledger-head h3 { margin: 0; font-size: 15px; }
.tag {
  display: inline-block;
  font-size: 12px;
  border-radius: 4px;
  padding: 1px 7px;
  margin-right: 4px;
}
.tag-abnormal { background: #fee4e2; color: #b42318; }
.tag-ok { background: #e7f6ec; color: #1a7f37; }
.row-dismissed { background: #f6f8fb; color: #475569; }
.basis-cell { min-width: 260px; font-size: 12px; color: #475569; }
</style>
