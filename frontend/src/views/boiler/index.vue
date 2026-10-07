<template>
  <section class="page" data-module="boiler">
    <header class="page-head">
      <div>
        <h2>余热锅炉运行管理</h2>
        <p class="page-desc">维护余热锅炉记录，围绕锅炉编号、主蒸汽压力、主蒸汽温度、给水流量做登记、筛选与状态流转。主蒸汽压力、主蒸汽温度为强制读数，缺项整条退回。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记锅炉读数</button>
        <button class="btn" type="button" @click="exportRows">导出运行清单</button>
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
      <span class="legend-item legend-warn">退回补录：{{ blockedCount }}</span>
      <span class="legend-item legend-warn">异常读数：{{ abnormalCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p class="sim-tip">
      取数链路自检：
      <button class="link" type="button" @click="simulateFailure('offline')">模拟取数失败</button>
      <span class="sim-sep">·</span>
      <button class="link" type="button" @click="simulateFailure('partial')">模拟读到一半断开</button>
      <span class="sim-sep">·</span>
      <button class="link" type="button" @click="reload">重新取数</button>
    </p>

    <div v-if="notice" class="notice" :class="notice.tone">
      <span>{{ notice.text }}</span>
      <button class="link" type="button" @click="notice = null">知道了</button>
    </div>

    <div v-if="loadState === 'loading'" class="state-panel">正在读取余热锅炉记录…</div>

    <div v-else-if="loadState === 'error'" class="state-panel error-panel">
      <p class="error-text">{{ loadError }}</p>
      <p class="state-sub">本次未渲染任何半截数据，卡片、图例与表格数字均未更新。</p>
      <button class="btn primary" type="button" @click="reload">再试一次</button>
    </div>

    <template v-else>
      <div v-if="blockedRows.length" class="blocked-banner">
        有 {{ blockedRows.length }} 条记录因主蒸汽压力/温度缺失被拦截退回：
        <span v-for="(item, idx) in blockedRows" :key="String(item.id)" class="banner-item">
          {{ item['锅炉编号'] }}（{{ verificationOf(item).text }}）<span v-if="idx < blockedRows.length - 1">；</span>
        </span>
      </div>

      <table v-if="rows.length" class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column.key">{{ column.label }}</th>
            <th>数据核验</th>
            <th>当前状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-blocked': isBlocked(row), 'row-abnormal': row.abnormal && !isBlocked(row) }">
            <td v-for="column in columns" :key="column.key">
              <template v-if="column.key === '排污率'">
                <span>{{ rateOf(row) }}</span>
              </template>
              <template v-else>
                <span :class="cellTone(row, column.key)">{{ cellText(row, column.key) }}</span>
              </template>
            </td>
            <td>
              <span class="verify-tag" :class="`tag-${verificationOf(row).tone}`">{{ verificationOf(row).text }}</span>
            </td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(row)">查看</button>
              <button class="link" type="button" @click="openDecision(row)">判异批复</button>
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                :disabled="isBlocked(row)"
                :title="isBlocked(row) ? '关键读数缺失，补录后才能流转' : ''"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="state-panel">
        <strong>暂无记录</strong>
        <p class="state-sub">{{ hasActiveFilter ? '没有符合当前筛选条件的余热锅炉记录，可重置条件后再看。' : '当前一条余热锅炉记录都没有，可点击右上角「登记锅炉读数」补录。' }}</p>
      </div>
    </template>

    <footer class="page-foot">
      <span>共 {{ loadState === 'ready' ? total : 0 }} 条余热锅炉运行记录（给水流量、排污量同口径：t/h；排污率 = 排污量÷给水流量，正常 1%～5%）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记弹窗 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记余热锅炉读数</h3>
        <p class="state-sub">同一台锅炉同一记录时间重复登记时，只保留最后一版。主蒸汽压力、主蒸汽温度缺项会整条退回。</p>
        <div v-if="createError" class="error-text form-error">{{ createError }}</div>
        <form class="modal-form" @submit.prevent="submitCreate">
          <label v-for="field in createFields" :key="field.key" class="form-item">
            <span>{{ field.label }}<em v-if="field.required">*</em></span>
            <input v-model="field.model" :placeholder="field.placeholder" />
          </label>
          <div class="modal-actions">
            <button class="btn" type="button" @click="createOpen = false">取消</button>
            <button class="btn primary" type="submit">提交登记</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 详情弹窗：点开不再一片白，缺的是没填还是读不出来都说明白 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal modal-wide">
        <h3>锅炉读数详情 · {{ detailRow['锅炉编号'] }}</h3>
        <table class="detail-table">
          <tbody>
            <tr v-for="item in detailItems" :key="item.label">
              <th>{{ item.label }}</th>
              <td :class="item.tone">{{ item.value }}</td>
            </tr>
          </tbody>
        </table>

        <h4 class="detail-h">数据核验</h4>
        <p :class="`tag-${verificationOf(detailRow).tone}`">{{ verificationOf(detailRow).text }}</p>
        <ul v-if="evaluationOf(detailRow).blocked.length" class="reason-list">
          <li v-for="issue in evaluationOf(detailRow).blocked" :key="issue.field" class="reason-missing">
            {{ issue.label }} —— {{ issue.level === 'failed' ? '仪表读到无效值，读数读不出来，需现场核对采集链路' : '还没有填这个数，需补录' }}
          </li>
        </ul>
        <ul v-if="evaluationOf(detailRow).anomalies.length" class="reason-list">
          <li v-for="(issue, idx) in evaluationOf(detailRow).anomalies" :key="`${issue.field}-${idx}`" class="reason-abnormal">
            <strong>{{ issue.label }}</strong>：{{ issue.reason ?? '读数缺失或无法解析' }}
          </li>
        </ul>

        <h4 class="detail-h">批复与留痕</h4>
        <p class="state-sub">
          版本 v{{ detailRow['版本'] ?? 1 }}；登记人：{{ detailRow['登记人'] || '—' }}；登记时间：{{ detailRow['登记时间'] || '—' }}
        </p>
        <p class="state-sub">
          判异批复：{{ detailRow['判异结果'] || '尚未批复' }}；批复人：{{ detailRow['判异人'] || '—' }}；批复时间：{{ detailRow['判异时间'] || '—' }}
        </p>
        <p v-if="detailRow['判异意见']" class="state-sub">批复意见：{{ detailRow['判异意见'] }}</p>
        <p v-if="detailRow['判异依据']" class="state-sub">判异依据：{{ detailRow['判异依据'] }}</p>

        <div class="modal-actions">
          <button class="btn" type="button" @click="detailRow = null">关闭</button>
          <button class="btn primary" type="button" @click="openDecision(detailRow)">判异批复</button>
        </div>
      </div>
    </div>

    <!-- 判异批复弹窗 -->
    <div v-if="decisionRow" class="modal-mask" @click.self="decisionRow = null">
      <div class="modal">
        <h3>异常读数批复 · {{ decisionRow['锅炉编号'] }}</h3>
        <p class="state-sub">判定为异常后，批复（含判定依据、意见、批复人、时间）会同步回写到值班交接遗留台账，可倒查。</p>
        <ul v-if="evaluationOf(decisionRow).anomalies.length" class="reason-list">
          <li v-for="(issue, idx) in evaluationOf(decisionRow).anomalies" :key="`${issue.field}-${idx}`" class="reason-abnormal">
            <strong>{{ issue.label }}</strong>：{{ issue.reason ?? '读数缺失或无法解析' }}
          </li>
        </ul>
        <p v-else class="state-sub">当前按口径没有核算出异常项，如现场确认有异常，请在意见中说明情况后判定。</p>
        <label class="form-item">
          <span>批复意见</span>
          <textarea v-model="decisionOpinion" rows="3" placeholder="如：排污率超标，已安排化验炉水并加大连排，下个班次复核"></textarea>
        </label>
        <div v-if="decisionError" class="error-text form-error">{{ decisionError }}</div>
        <div class="modal-actions">
          <button class="btn" type="button" @click="decisionRow = null">取消</button>
          <button v-if="decisionRow.abnormal" class="btn" type="button" @click="submitDecision(false)">复核正常，解除异常</button>
          <button class="btn primary" type="button" @click="submitDecision(true)">判定异常，回写遗留台账</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  armBoilerFailure,
  decideBoilerAbnormal,
  describeBlowdownRate,
  downloadEntries,
  fetchBoilerEntries,
  calcBlowdownRate,
  moduleMeta,
  registerBoilerEntry,
  runAction as applyAction,
  summarizeVerification,
} from '@/api/local-service'
import { BOILER_UNIT, READ_FAILED, evaluateBoilerRow } from '@/data/boiler-rules'
import type { BoilerFailureMode } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const meta = moduleMeta('boiler')
const actions = ['提交投运', '登记停运', '安排检修']

const columns = [
  { key: '锅炉编号', label: '锅炉编号' },
  { key: '主蒸汽压力', label: `主蒸汽压力(MPa)` },
  { key: '主蒸汽温度', label: '主蒸汽温度(℃)' },
  { key: '给水流量', label: `给水流量(${BOILER_UNIT})` },
  { key: '排污量', label: `排污量(${BOILER_UNIT})` },
  { key: '排污率', label: '排污率' },
  { key: '运行班次', label: '运行班次' },
  { key: '记录时间', label: '记录时间' },
]

// 表格、卡片、图例全部来自 rows 这同一份取数结果，重试后一起更新，不存在两处对不上。
const rows = ref<EntryRow[]>([])
const total = ref(0)
const loadState = ref<'loading' | 'error' | 'ready'>('loading')
const loadError = ref('')
const errorMessage = ref('')
const notice = ref<{ text: string; tone: 'ok' | 'warn' } | null>(null)
const filters = ref<Record<string, string>>({ 锅炉编号: '', 运行班次: '' })
const filterFields = ['锅炉编号', '运行班次']

const stats = computed(() => [
  { label: '运行中锅炉', value: rows.value.filter((row) => String(row.status) === '运行中').length },
  { label: '已停运锅炉', value: rows.value.filter((row) => String(row.status) === '已停运').length },
  { label: '检修中锅炉', value: rows.value.filter((row) => String(row.status) === '检修中').length },
  { label: '异常读数记录', value: abnormalCount.value },
])

const statusSummary = computed(() =>
  ['待投运', '运行中', '已停运', '检修中'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const blockedRows = computed(() => rows.value.filter((row) => isBlocked(row)))
const blockedCount = computed(() => blockedRows.value.length)
const abnormalCount = computed(() => rows.value.filter((row) => row.abnormal === true).length)
const hasActiveFilter = computed(() =>
  Object.values(filters.value).some((value) => value.trim() !== ''),
)

function isBlocked(row: EntryRow): boolean {
  return evaluateBoilerRow(row).blocked.length > 0
}

function evaluationOf(row: EntryRow) {
  return evaluateBoilerRow(row)
}

function verificationOf(row: EntryRow) {
  return summarizeVerification(row)
}

function cellText(row: EntryRow, field: string): string {
  const value = row[field]
  const text = value === undefined || value === null ? '' : String(value).trim()
  if (text === '') {
    return '未填报'
  }
  return text === READ_FAILED ? READ_FAILED : text
}

function cellTone(row: EntryRow, field: string): string {
  const text = cellText(row, field)
  if (text === '未填报') {
    return 'cell-missing'
  }
  if (text === READ_FAILED) {
    return 'cell-failed'
  }
  const hit = evaluateBoilerRow(row).anomalies.some((issue) => issue.field === field)
  return hit ? 'cell-abnormal' : ''
}

function rateOf(row: EntryRow): string {
  return describeBlowdownRate(calcBlowdownRate(row))
}

async function reload() {
  loadState.value = 'loading'
  loadError.value = ''
  errorMessage.value = ''
  const result = await fetchBoilerEntries(filters.value)
  if (!result.ok) {
    // 取数失败 / 中途断开：保留旧数据不可信，清空显示并要求再试一次。
    rows.value = []
    total.value = 0
    loadError.value = result.message
    loadState.value = 'error'
    return
  }
  rows.value = result.items
  total.value = result.total
  loadState.value = 'ready'
}

function resetFilters() {
  filters.value = { 锅炉编号: '', 运行班次: '' }
  void reload()
}

function simulateFailure(mode: BoilerFailureMode) {
  armBoilerFailure(mode)
  void reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  void reload()
}

// —— 登记 ——

const createOpen = ref(false)
const createError = ref('')
const createForm = reactive({
  boilerNo: '',
  pressure: '',
  temperature: '',
  feed: '',
  blowdown: '',
  shift: session.shiftLabel,
  recordedAt: '',
})
const createFields = computed(() => [
  { key: 'boilerNo', label: '锅炉编号', model: createForm.boilerNo, required: true, placeholder: '如 BOIL-0002' },
  { key: 'recordedAt', label: '记录时间', model: createForm.recordedAt, required: true, placeholder: '如 2026-10-07 14:00' },
  { key: 'pressure', label: '主蒸汽压力(MPa)', model: createForm.pressure, required: true, placeholder: '缺项会整条退回' },
  { key: 'temperature', label: '主蒸汽温度(℃)', model: createForm.temperature, required: true, placeholder: '读不出来请现场核对，不能留空入库' },
  { key: 'feed', label: `给水流量(${BOILER_UNIT})`, model: createForm.feed, required: false, placeholder: '与排污量同口径 t/h' },
  { key: 'blowdown', label: `排污量(${BOILER_UNIT})`, model: createForm.blowdown, required: false, placeholder: '与给水流量同口径 t/h' },
  { key: 'shift', label: '运行班次', model: createForm.shift, required: false, placeholder: '如 白班 08:00-20:00' },
])

function openCreate() {
  createError.value = ''
  createOpen.value = true
}

function submitCreate() {
  createError.value = ''
  const result = registerBoilerEntry({
    boilerNo: createForm.boilerNo,
    pressure: createForm.pressure,
    temperature: createForm.temperature,
    feed: createForm.feed,
    blowdown: createForm.blowdown,
    shift: createForm.shift,
    recordedAt: createForm.recordedAt,
    operator: session.operator,
  })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  notice.value = { text: result.message, tone: result.message.includes('异常') ? 'warn' : 'ok' }
  void reload()
}

// —— 详情 ——

const detailRow = ref<EntryRow | null>(null)

const detailItems = computed(() => {
  const row = detailRow.value
  if (!row) {
    return []
  }
  return [
    { label: '锅炉编号', value: String(row['锅炉编号'] ?? ''), tone: '' },
    { label: '记录时间', value: String(row['记录时间'] ?? ''), tone: '' },
    { label: '运行班次', value: String(row['运行班次'] ?? ''), tone: '' },
    { label: '主蒸汽压力(MPa)', value: cellText(row, '主蒸汽压力'), tone: cellTone(row, '主蒸汽压力') },
    { label: '主蒸汽温度(℃)', value: cellText(row, '主蒸汽温度'), tone: cellTone(row, '主蒸汽温度') },
    { label: `给水流量(${BOILER_UNIT})`, value: cellText(row, '给水流量'), tone: cellTone(row, '给水流量') },
    { label: `排污量(${BOILER_UNIT})`, value: cellText(row, '排污量'), tone: cellTone(row, '排污量') },
    { label: '排污率', value: rateOf(row), tone: evaluationOf(row).blowdownRate === null ? '' : (row.abnormal ? 'cell-abnormal' : '') },
    { label: '当前状态', value: String(row.status ?? ''), tone: '' },
  ]
})

function openDetail(row: EntryRow) {
  detailRow.value = row
}

// —— 判异批复 ——

const decisionRow = ref<EntryRow | null>(null)
const decisionOpinion = ref('')
const decisionError = ref('')

function openDecision(row: EntryRow) {
  decisionError.value = ''
  decisionOpinion.value = ''
  decisionRow.value = row
}

function submitDecision(abnormal: boolean) {
  if (!decisionRow.value) {
    return
  }
  const result = decideBoilerAbnormal(Number(decisionRow.value.id), {
    abnormal,
    opinion: decisionOpinion.value,
    operator: session.operator,
    shiftLabel: session.shiftLabel,
  })
  if (!result.ok) {
    decisionError.value = result.message
    return
  }
  decisionRow.value = null
  detailRow.value = null
  notice.value = { text: result.message, tone: abnormal ? 'warn' : 'ok' }
  void reload()
}

onMounted(reload)
</script>
