<template>
  <section class="page" data-module="boiler">
    <header class="page-head">
      <div>
        <h2>余热锅炉运行管理</h2>
        <p class="page-desc">
          主蒸汽压力/温度缺失整条拦下；给水流量与排污量按同一口径核算排污率（正常区间 2%~10%），
          异常读数标出并附判定依据；同一台锅炉重复登记以最后一版为准；异常批复回写值班交接遗留台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记余热锅炉记录</button>
        <button class="btn" type="button" @click="exportRows">导出余热锅炉运行清单</button>
      </div>
    </header>

    <div v-if="loading" class="state-banner loading">余热锅炉记录读取中…</div>

    <div v-else-if="loadError" class="state-banner failed" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn primary" type="button" @click="reload">再试一次</button>
    </div>

    <template v-else>
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card" :class="{ warn: item.value > 0 && item.label !== '运行中锅炉' && item.label !== '已停运锅炉' && item.label !== '检修中锅炉' }">
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

      <p class="rule-note">
        核算口径：排污率 = 排污量 ÷ 给水流量 × 100%（两项读数均按 t/h 取值）；正常区间 {{ rateMin }}%~{{ rateMax }}%，
        超区间、读数无法识别或两项对不上的标为异常。
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>核算与判定依据</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="snap in snapshots" :key="String(snap.id)" :class="{ 'row-abnormal': snap.abnormal }">
            <td>{{ snap['锅炉编号'] }}</td>
            <td>
              <span v-if="snap.pressure.kind === 'blank'" class="tag tag-missing">未填报</span>
              <span v-else-if="snap.pressure.kind === 'unreadable'" class="tag tag-unreadable">读不出来</span>
              <span v-else>{{ snap.pressure.raw }}</span>
            </td>
            <td>
              <span v-if="snap.temperature.kind === 'blank'" class="tag tag-missing">未填报</span>
              <span v-else-if="snap.temperature.kind === 'unreadable'" class="tag tag-unreadable">读不出来</span>
              <span v-else>{{ snap.temperature.raw }}</span>
            </td>
            <td>
              <span v-if="snap.accounting.feed.kind === 'blank'" class="tag tag-missing">未填报</span>
              <span v-else-if="snap.accounting.feed.kind === 'unreadable'" class="tag tag-unreadable">{{ snap.accounting.feed.raw }}</span>
              <span v-else>{{ snap.accounting.feed.raw }}</span>
            </td>
            <td>
              <span v-if="snap.accounting.blowdown.kind === 'blank'" class="tag tag-missing">未填报</span>
              <span v-else-if="snap.accounting.blowdown.kind === 'unreadable'" class="tag tag-unreadable">{{ snap.accounting.blowdown.raw }}</span>
              <span v-else>{{ snap.accounting.blowdown.raw }}</span>
            </td>
            <td>{{ snap['运行班次'] ?? '—' }}</td>
            <td>{{ snap['记录时间'] ?? '—' }}</td>
            <td>
              <strong>{{ formatRate(snap.accounting.rate) }}</strong>
              <span v-if="snap.accounting.abnormal" class="tag tag-abnormal">异常</span>
              <span v-else-if="snap.accounting.rate !== null" class="tag tag-ok">正常</span>
              <p class="cell-note">{{ snap.accounting.reason }}</p>
            </td>
            <td>
              {{ snap.status }}
              <span v-if="snap.incomplete" class="tag tag-missing">资料不全</span>
              <span v-if="verdictText(snap)" class="tag" :class="snap.abnormal ? 'tag-abnormal' : 'tag-ok'">{{ verdictText(snap) }}</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(snap)">查看</button>
              <button class="link" type="button" @click="changeStatus(snap, '提交投运')">提交投运</button>
              <button class="link" type="button" @click="changeStatus(snap, '登记停运')">登记停运</button>
              <button class="link" type="button" @click="changeStatus(snap, '安排检修')">安排检修</button>
              <button
                v-if="snap.accounting.abnormal && !verdictOf(snap)"
                class="link link-danger"
                type="button"
                @click="openVerdict(snap)"
              >
                判定异常
              </button>
              <button
                v-if="verdictOf(snap)"
                class="link"
                type="button"
                @click="openVerdict(snap)"
              >
                {{ snap.abnormal ? '撤销异常判定' : '改判记录' }}
              </button>
            </td>
          </tr>
          <tr v-if="!snapshots.length">
            <td :colspan="columns.length + 3" class="empty-state">{{ emptyText }}</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条余热锅炉运行记录{{ hasActiveFilter ? '（当前为筛选结果）' : '' }}</span>
        <span class="foot-tools">
          <button class="link" type="button" @click="simulateFailure">模拟下一次取数断掉</button>
          <span v-if="actionMessage" :class="actionOk ? 'ok-text' : 'error-text'">{{ actionMessage }}</span>
        </span>
      </footer>
    </template>

    <!-- 登记弹窗：主蒸汽压力/温度缺失整条拦下并点名缺项 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记余热锅炉记录</h3>
        <p class="modal-hint">同一台锅炉编号重复登记时，只保留最后一版。主蒸汽压力、主蒸汽温度为必填。</p>
        <div class="form-grid">
          <label><span>锅炉编号 *</span><input v-model="form.boilerId" placeholder="如 BOIL-0006" /></label>
          <label><span>主蒸汽压力 *</span><input v-model="form.pressure" placeholder="如 4.2 MPa" /></label>
          <label><span>主蒸汽温度 *</span><input v-model="form.temperature" placeholder="如 405 ℃" /></label>
          <label><span>给水流量（t/h）</span><input v-model="form.feed" placeholder="如 42.0" /></label>
          <label><span>排污量（t/h）</span><input v-model="form.blowdown" placeholder="如 2.1" /></label>
          <label><span>运行班次</span><input v-model="form.shift" /></label>
          <label class="wide"><span>记录时间</span><input v-model="form.recordedAt" placeholder="YYYY-MM-DD HH:mm" /></label>
        </div>
        <p v-if="createError" class="error-text form-error">{{ createError }}</p>
        <p v-else class="form-tip">提交后按「排污率 = 排污量 ÷ 给水流量 × 100%」即时核算，异常读数会被标出。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗：缺的、读不出来的都点名，不再一片白 -->
    <div v-if="detailSnap" class="modal-mask" @click.self="detailSnap = null">
      <div class="modal">
        <h3>锅炉 {{ detailSnap['锅炉编号'] }} 运行记录详情</h3>
        <dl class="detail-list">
          <div v-for="field in detailFields" :key="field.name">
            <dt>{{ field.name }}</dt>
            <dd>
              <span v-if="field.reading?.kind === 'blank'" class="tag tag-missing">未填报</span>
              <span v-else-if="field.reading?.kind === 'unreadable'" class="tag tag-unreadable">读不出来（{{ field.reading.raw }}）</span>
              <span v-else>{{ field.text || '—' }}</span>
            </dd>
          </div>
          <div>
            <dt>核算结论</dt>
            <dd>
              <span class="tag" :class="detailSnap.accounting.abnormal ? 'tag-abnormal' : 'tag-ok'">
                {{ detailSnap.accounting.abnormal ? '读数异常' : '未见异常' }}
              </span>
              {{ detailSnap.accounting.reason }}
            </dd>
          </div>
          <div v-if="verdictOf(detailSnap)">
            <dt>异常判定批复</dt>
            <dd>
              <p>{{ verdictOf(detailSnap)?.comment || '（无批复意见）' }}</p>
              <p class="cell-note">
                {{ verdictOf(detailSnap)?.decision === 'confirmed' ? '确认异常' : '解除异常' }} ·
                批复人 {{ verdictOf(detailSnap)?.reviewer }} · {{ verdictOf(detailSnap)?.time }}
              </p>
            </dd>
          </div>
          <div v-if="detailSnap.incomplete">
            <dt>资料完整性</dt>
            <dd><span class="tag tag-missing">资料不全：缺 {{ detailSnap.missingFields.join('、') }}</span></dd>
          </div>
        </dl>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="detailSnap = null">关闭</button>
          <button class="btn primary" type="button" @click="openVerdictFromDetail">异常批复</button>
        </div>
      </div>
    </div>

    <!-- 异常判定批复弹窗：结论回写值班交接遗留台账 -->
    <div v-if="verdictSnap" class="modal-mask" @click.self="verdictSnap = null">
      <div class="modal">
        <h3>异常判定批复 · 锅炉 {{ verdictSnap['锅炉编号'] }}</h3>
        <dl class="detail-list">
          <div>
            <dt>核算依据</dt>
            <dd>
              排污率 <strong>{{ formatRate(verdictSnap.accounting.rate) }}</strong>；{{ verdictSnap.accounting.reason }}
            </dd>
          </div>
          <div v-if="verdictOf(verdictSnap)">
            <dt>上次批复</dt>
            <dd class="cell-note">
              {{ verdictOf(verdictSnap)?.decision === 'confirmed' ? '确认异常' : '解除异常' }} ·
              {{ verdictOf(verdictSnap)?.reviewer }} · {{ verdictOf(verdictSnap)?.time }} ·
              {{ verdictOf(verdictSnap)?.comment }}
            </dd>
          </div>
        </dl>
        <label class="verdict-comment">
          <span>批复意见（将回写值班交接遗留台账）</span>
          <textarea v-model="verdictComment" rows="3" placeholder="如：确认排污量异常，已通知检修核对，列入下班遗留事项"></textarea>
        </label>
        <p v-if="verdictError" class="error-text form-error">{{ verdictError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="verdictSnap = null">取消</button>
          <button class="btn" type="button" @click="submitVerdict('dismissed')">解除异常</button>
          <button class="btn primary" type="button" @click="submitVerdict('confirmed')">确认异常</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  armNextLoadFailure,
  changeBoilerStatus,
  fetchBoilerEntries,
  submitBoilerEntry,
  verdictBoilerEntry,
} from '@/api/boiler-service'
import {
  asBoilerVerdict,
  BLOWDOWN_RATE_MAX,
  BLOWDOWN_RATE_MIN,
  formatRate,
  type BoilerSnapshot,
  type NumericReading,
  type VerdictDecision,
} from '@/data/boiler-domain'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const columns = ['锅炉编号', '主蒸汽压力', '主蒸汽温度', '给水流量', '排污量', '运行班次', '记录时间']
const filterFields = ['锅炉编号', '主蒸汽压力', '主蒸汽温度']
const statuses = ['待投运', '运行中', '已停运', '检修中']
const rateMin = BLOWDOWN_RATE_MIN
const rateMax = BLOWDOWN_RATE_MAX

const snapshots = ref<BoilerSnapshot[]>([])
const stats = ref<{ label: string; value: number }[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const filters = ref<Record<string, string>>({})
const actionMessage = ref('')
const actionOk = ref(true)

const hasActiveFilter = computed(() =>
  Object.values(filters.value).some((value) => value.trim() !== ''),
)
const emptyText = computed(() =>
  hasActiveFilter.value
    ? '没有符合筛选条件的余热锅炉记录，可调整条件或重置后再查'
    : '暂无记录',
)
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: snapshots.value.filter((snap) => snap.status === status).length,
  })),
)

async function reload() {
  loading.value = true
  loadError.value = ''
  actionMessage.value = ''
  try {
    // 列表、统计卡片、状态图例同一次取数、同一份快照，重试后两处数一定对得上。
    const page = await fetchBoilerEntries(filters.value)
    snapshots.value = page.items
    stats.value = page.stats
    total.value = page.total
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '余热锅炉记录取数失败，请再试一次'
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('boiler')
}

function simulateFailure() {
  armNextLoadFailure()
  actionMessage.value = '已让下一次取数失败，点击查询或再试一次即可观察兜底表现'
  actionOk.value = true
}

// ---- 登记 ----
const createOpen = ref(false)
const createError = ref('')
const form = reactive({
  boilerId: '',
  pressure: '',
  temperature: '',
  feed: '',
  blowdown: '',
  shift: '',
  recordedAt: '',
})

function openCreate() {
  Object.assign(form, {
    boilerId: '',
    pressure: '',
    temperature: '',
    feed: '',
    blowdown: '',
    shift: store.shiftLabel,
    recordedAt: '',
  })
  createError.value = ''
  createOpen.value = true
}

function submitCreate() {
  const outcome = submitBoilerEntry({ ...form }, store.operator)
  if (!outcome.ok) {
    createError.value = outcome.message
    return
  }
  createOpen.value = false
  actionMessage.value = outcome.message
  actionOk.value = true
  reload()
}

// ---- 详情 ----
const detailSnap = ref<BoilerSnapshot | null>(null)

const detailFields = computed(() => {
  const snap = detailSnap.value
  if (!snap) return []
  const withReading = (name: string, raw: unknown, reading?: NumericReading) => ({
    name,
    text: String(raw ?? ''),
    reading,
  })
  return [
    withReading('锅炉编号', snap['锅炉编号']),
    withReading('主蒸汽压力', snap['主蒸汽压力'], snap.pressure),
    withReading('主蒸汽温度', snap['主蒸汽温度'], snap.temperature),
    withReading('给水流量', snap['给水流量'], snap.accounting.feed),
    withReading('排污量', snap['排污量'], snap.accounting.blowdown),
    withReading('运行班次', snap['运行班次']),
    withReading('记录时间', snap['记录时间']),
    withReading('最后修改人', snap['最后修改人']),
    withReading('最后修改时间', snap['最后修改时间']),
  ]
})

function openDetail(snap: BoilerSnapshot) {
  detailSnap.value = snap
}

// ---- 状态动作 ----
function changeStatus(snap: BoilerSnapshot, action: string) {
  const message = changeBoilerStatus(Number(snap.id), action)
  if (message) {
    actionMessage.value = message
    actionOk.value = !message.includes('没有登记') && !message.includes('没有找到') && !message.includes('不用重复')
  }
  reload()
}

// ---- 异常判定批复 ----
const verdictSnap = ref<BoilerSnapshot | null>(null)
const verdictComment = ref('')
const verdictError = ref('')

function verdictOf(snap: BoilerSnapshot) {
  return asBoilerVerdict(snap['判定批复'])
}

function verdictText(snap: BoilerSnapshot): string {
  const verdict = verdictOf(snap)
  if (!verdict) return ''
  return verdict.decision === 'confirmed' ? '已判定异常' : '已解除异常'
}

function openVerdict(snap: BoilerSnapshot) {
  verdictSnap.value = snap
  const verdict = verdictOf(snap)
  verdictComment.value = verdict?.comment ?? ''
  verdictError.value = ''
}

function openVerdictFromDetail() {
  if (!detailSnap.value) return
  openVerdict(detailSnap.value)
  detailSnap.value = null
}

function submitVerdict(decision: VerdictDecision) {
  if (!verdictSnap.value) return
  if (!verdictComment.value.trim()) {
    verdictError.value = '请填写批复意见，台账需要留下判定依据'
    return
  }
  const message = verdictBoilerEntry(
    Number(verdictSnap.value.id),
    decision,
    verdictComment.value,
    store.operator,
  )
  if (!message) {
    verdictError.value = '没有找到这条锅炉记录，可能已被覆盖'
    return
  }
  verdictSnap.value = null
  actionMessage.value = message
  actionOk.value = true
  reload()
}

onMounted(reload)
</script>

<style scoped>
.state-banner {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  background: #fff;
  text-align: center;
  margin: 12px 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
}
.state-banner.loading { color: var(--muted); }
.state-banner.failed { border-color: #f0b7b0; background: #fef3f2; color: #b42318; justify-content: space-between; }
.stat-card.warn { border-color: #e6a23c; background: #fdf6ec; }
.rule-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
  background: #eef2f7;
  border-radius: 6px;
  padding: 6px 10px;
}
.row-abnormal { background: #fef3f2; }
.cell-note { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.tag {
  display: inline-block;
  font-size: 12px;
  border-radius: 4px;
  padding: 1px 7px;
  margin-right: 4px;
  background: #eef2f7;
  color: #475569;
}
.tag-missing { background: #f1f5f9; color: #64748b; border: 1px dashed #94a3b8; }
.tag-unreadable { background: #fff7ed; color: #c2410c; border: 1px solid #fdba74; }
.tag-abnormal { background: #fee4e2; color: #b42318; }
.tag-ok { background: #e7f6ec; color: #1a7f37; }
.link-danger { color: #b42318; }
.ok-text { color: #1a7f37; }
.foot-tools { display: flex; gap: 12px; align-items: center; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 20px 24px;
}
.modal h3 { margin: 0 0 8px; }
.modal-hint { margin: 0 0 14px; font-size: 12px; color: var(--muted); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.form-grid label span, .verdict-comment span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.form-grid input, .verdict-comment textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.form-grid .wide { grid-column: 1 / -1; }
.form-error { margin: 10px 0 0; }
.form-tip { margin: 10px 0 0; font-size: 12px; color: var(--muted); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.detail-list { margin: 0; }
.detail-list > div { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px dashed var(--border); }
.detail-list dt { width: 110px; flex-shrink: 0; color: var(--muted); font-size: 13px; }
.detail-list dd { margin: 0; font-size: 13px; }
.verdict-comment { display: block; margin-top: 12px; }
</style>
