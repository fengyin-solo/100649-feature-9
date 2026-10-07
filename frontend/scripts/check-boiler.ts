import { registerBoiler, applyBoilerVerdict, accountFlows, snapshotFor, nowText } from '../src/data/boiler-domain'
import { appendLegacyLedger, listLegacyLedger } from '../src/data/legacy-ledger'
import { SEED_ROWS } from '../src/data/seed'
import type { EntryRow } from '../src/data/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, extra) }
}

// 1. 缺主蒸汽压力/温度：整条拦下并点名
const empty: EntryRow[] = []
const r1 = registerBoiler(empty, { boilerId: 'B1', pressure: '', temperature: '380', feed: '40', blowdown: '2', shift: '白班', recordedAt: '' }, '张三')
check('缺压力被退回', !r1.outcome.ok)
check('退回点名缺主蒸汽压力', r1.outcome.ok === false && r1.outcome.message.includes('主蒸汽压力'))
check('缺项时不落库', r1.rows.length === 0)

const r1b = registerBoiler(empty, { boilerId: 'B1', pressure: '4.0', temperature: '', feed: '40', blowdown: '2', shift: '白班', recordedAt: '' }, '张三')
check('缺温度退回并点名', !r1b.outcome.ok && r1b.outcome.message.includes('主蒸汽温度'))

// 2. 正常登记 + 排污率核算
const r2 = registerBoiler(empty, { boilerId: 'B1', pressure: '4.0 MPa', temperature: '400 ℃', feed: '40', blowdown: '2', shift: '白班', recordedAt: '' }, '张三')
check('正常登记成功', r2.outcome.ok && r2.rows.length === 1)
check('排污率5%正常', String(r2.rows[0]['排污率']) === '5.00%' && r2.rows[0].abnormal === false)

// 3. 排污率超区间 → 异常 + 依据
const accHi = accountFlows('24', '4')
check('排污率16.67%判异常', accHi.abnormal === true && accHi.rate !== null && Math.abs(accHi.rate - 16.67) < 0.01)
check('异常依据含算式与区间', accHi.reason.includes('16.67%') && accHi.reason.includes('2%~10%'))
const accLo = accountFlows('38', '0.6')
check('排污率1.58%低于下限判异常', accLo.abnormal && (accLo.rate ?? 0) < 2)

// 4. 读不出来 + 对不上
const accBad = accountFlows('采集失败', '1')
check('读数无法识别判异常', accBad.abnormal && accBad.reason.includes('无法识别'))
const accNeg = accountFlows('40', '-2')
check('负读数判异常', accNeg.abnormal && accNeg.reason.includes('负数'))
const accMismatch = accountFlows('0', '3')
check('给水0却有排污判异常', accMismatch.abnormal && accMismatch.reason.includes('对不上'))
const accOk = accountFlows('0', '0')
check('双0不算异常', !accOk.abnormal)

// 5. 重复登记只记一次、最后一版为准
const after = r2.rows
const r3 = registerBoiler(after, { boilerId: 'B1', pressure: '4.3 MPa', temperature: '410 ℃', feed: '44', blowdown: '2.2', shift: '夜班', recordedAt: '' }, '李四')
check('重复登记仍只有一条', r3.outcome.ok && r3.rows.length === 1)
check('覆盖标记replaced', (r3.outcome as { replaced: boolean }).replaced === true)
check('以最后一版为准', String(r3.rows[0]['主蒸汽压力']) === '4.3 MPa' && String(r3.rows[0]['最后修改人']) === '李四')

// 6. 批复回写 + 台账倒查
const v = applyBoilerVerdict(r3.rows, Number(r3.rows[0].id), 'confirmed', '确认异常，列入遗留', '王五')
check('批复有结果', v !== null)
if (v) {
  appendLegacyLedger(v.ledgerEntry)
  const saved = v.rows[0]
  check('记录标记为异常', saved.abnormal === true)
  const ledger = listLegacyLedger()
  const last = ledger[ledger.length - 1]
  check('台账有追加', last.boilerId === 'B1' && last.reviewer === '王五' && last.decision === 'confirmed')
  check('台账含时间', last.time.length > 0)
  check('台账含判定依据', last.basis.includes('排污率'))
  // 解除异常
  const v2 = applyBoilerVerdict(v.rows, Number(v.rows[0].id), 'dismissed', '复测正常，解除', '赵六')
  if (v2) {
    appendLegacyLedger(v2.ledgerEntry)
    check('解除后记录不再异常', v2.rows[0].abnormal === false)
    check('台账两次批复都在(可倒查)', listLegacyLedger().length >= ledger.length + 1)
    check('解除台账有赵六和时间', listLegacyLedger().slice(-1)[0].reviewer === '赵六')
  }
}

// 7. seed 数据快照
const snaps = SEED_ROWS.boiler.map(snapshotFor)
const incomplete = snaps.filter((s) => s.incomplete)
check('seed有1条资料不全(BOIL-0003)', incomplete.length === 1 && String(incomplete[0]['锅炉编号']) === 'BOIL-0003')
check('资料不全点名缺两项', incomplete[0]?.missingFields.join('、') === '主蒸汽压力、主蒸汽温度')
check('BOIL-0005采集失败判异常', snaps.find((s) => String(s['锅炉编号']) === 'BOIL-0005')?.accounting.abnormal === true)
check('BOIL-0004排污率16.67异常', snaps.find((s) => String(s['锅炉编号']) === 'BOIL-0004')?.accounting.abnormal === true)
check('BOIL-0001正常', snaps.find((s) => String(s['锅炉编号']) === 'BOIL-0001')?.accounting.abnormal === false)
check('nowText格式', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(nowText()))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
