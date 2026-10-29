'use strict'

// 喂鱼 + 饱腹度 + 节日彩蛋。
//
// 饱腹度是 0~100 的一个数，随时间匀速下降，喂一次涨一点。
// 关键是它**不用定时回写**：状态里存的是「上次喂食后的值 + 当时的时间戳」，
// 每次读取时按过去了多少小时现算衰减。所以关掉桌宠再打开、甚至隔了三天，
// 算出来的饱腹度都是对的，不需要后台跑计时器。
//
// 节日用的是**农历**：端午五月初五、中秋八月十五、元宵正月十五……
// 农历日期靠 Intl 的 chinese calendar 算，不引第三方库，也不用每年手工改日期表。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

// 农历格式化器构造一次就够，别每次调用都 new
let lunarFmt = null
function lunarKey(date) {
  try {
    if (!lunarFmt) {
      lunarFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' })
    }
    const parts = lunarFmt.formatToParts(date)
    const m = parts.find((p) => p.type === 'month')
    const d = parts.find((p) => p.type === 'day')
    if (!m || !d) return ''
    return `${Number(m.value)}-${Number(d.value)}`
  } catch (e) {
    return '' // 没有 chinese calendar 就退化为没有节日，不影响喂食
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function file() {
  return path.join(app.getPath('userData'), 'feed.json')
}

function read() {
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return o && Number.isFinite(o.value) ? o : null
  } catch (e) {
    return null
  }
}

function write(o) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(o), 'utf8')
  } catch (e) {
    /* 写不进去就算了，不影响当次喂食 */
  }
}

function cfgOf(cfg) {
  return (cfg && cfg.feed) || {}
}

// 当前饱腹度。关掉功能时返回 null，上层据此不显示相关菜单
function fullness(cfg) {
  const f = cfgOf(cfg)
  if (f.enabled === false) return null
  const st = read()
  if (!st) return clamp(f.initial == null ? 70 : f.initial, 0, 100)
  const perHour = f.decayPerHour == null ? 5 : f.decayPerHour
  const hours = Math.max(0, (Date.now() - (st.at || Date.now())) / 3600000)
  return clamp(st.value - hours * perHour, 0, 100)
}

// 喂一次。返回喂之前/之后的值，好让气泡说「吃饱了」还是「还能再来点」
function feed(cfg, food) {
  const f = cfgOf(cfg)
  const before = fullness(cfg)
  if (before == null) return null
  const lo = f.gainMin == null ? 20 : f.gainMin
  const hi = f.gainMax == null ? 30 : f.gainMax
  const gain = lo + Math.random() * Math.max(0, hi - lo)
  const after = clamp(before + gain, 0, 100)
  write({ value: after, at: Date.now(), lastFood: food || '' })
  return { food, before: Math.round(before), after: Math.round(after), gain: Math.round(gain) }
}

function seasonOf(date) {
  const m = date.getMonth() + 1
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'autumn'
  return 'winter'
}

function slotOf(date) {
  const h = date.getHours()
  if (h >= 5 && h < 10) return 'morning'
  if (h >= 11 && h < 14) return 'noon'
  if (h >= 17 && h < 21) return 'night'
  return ''
}

function isBirthday(v, date) {
  const s = String(v || '').trim()
  if (!s) return false
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (!m) return false
  return Number(m[1]) === date.getMonth() + 1 && Number(m[2]) === date.getDate()
}

// 选今天该吃什么：生日 > 农历节日 > 时令/时刻混合随机 > 兜底
function pickFood(cfg, date) {
  const f = cfgOf(cfg)
  const now = date || new Date()

  if (isBirthday(f.birthday, now)) return f.birthdayFood || '吃长寿面'

  const key = lunarKey(now)
  if (key && f.festivals && f.festivals[key]) return f.festivals[key]

  // 时令和时刻各贡献一批候选，混着随机，既应景又不至于每次都同一口。
  // 时段食物（早/午/晚餐）权重给 3：八点钟更该想吃早餐，而不是刚好秋天就啃糖葫芦
  const cand = []
  const push = (arr, w) => {
    if (Array.isArray(arr)) for (const x of arr) cand.push([x, w])
  }
  push((f.byHour || {})[slotOf(now)], 3)
  push((f.seasons || {})[seasonOf(now)], 1)
  push(f.any, 1)

  if (!cand.length) return '吃白饭'
  const total = cand.reduce((s, c) => s + c[1], 0)
  let r = Math.random() * total
  for (const c of cand) {
    r -= c[1]
    if (r <= 0) return c[0]
  }
  return cand[cand.length - 1][0]
}

// 今天是不是什么日子，用来在菜单上提示（「今天端午哦」）
function occasionOf(cfg, date) {
  const f = cfgOf(cfg)
  const now = date || new Date()
  if (isBirthday(f.birthday, now)) return '生日'
  const key = lunarKey(now)
  const names = f.festivalNames || {}
  return names[key] || ''
}

// 饱腹度档位 → 一句话。气泡和菜单都用它
function moodOf(cfg, value) {
  const f = cfgOf(cfg)
  if (value == null) return ''
  const hungry = f.hungryAt == null ? 25 : f.hungryAt
  const stuffed = f.stuffedAt == null ? 90 : f.stuffedAt
  if (value <= hungry) return 'hungry'
  if (value >= stuffed) return 'stuffed'
  return 'ok'
}

function lineFor(cfg, mood) {
  const lines = (cfgOf(cfg).lines || {})[mood]
  if (Array.isArray(lines) && lines.length) {
    return lines[Math.floor(Math.random() * lines.length)]
  }
  return mood === 'hungry' ? '肚子饿了…' : mood === 'stuffed' ? '吃撑了…' : '谢谢款待~'
}

module.exports = { fullness, feed, pickFood, occasionOf, moodOf, lineFor, lunarKey }
