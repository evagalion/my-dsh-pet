'use strict'

// 「今天是什么日子 / 现在是什么时候」——节日动作和作息动画都靠它判定。
//
// 农历照旧走 Intl 的 chinese calendar，不引第三方库、不用每年手改日期表。
// 这里全是纯函数（不读文件、不存状态），有状态的触发判定在 routine.js。
//
// 节日分三层，优先级从高到低：
//   农历节日（春节/元宵/端午/七夕/中秋/重阳/腊八）
//   > 公历节日（元旦/万圣/圣诞）
//   > 时令（春放风筝 / 夏摇扇 / 秋落叶 / 冬堆雪人）
// 前两层是「今天过节」，第三层只是「这个季节应景」，渲染层给的播放概率更低。

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
    return '' // 没有 chinese calendar 就退化为不过节，不影响其它功能
  }
}

function solarKey(date) {
  return `${date.getMonth() + 1}-${date.getDate()}`
}

function seasonOf(date) {
  const m = date.getMonth() + 1
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'autumn'
  return 'winter'
}

const SEASON_NAMES = { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' }

function slotOf(date) {
  const h = date.getHours()
  if (h >= 5 && h < 10) return 'morning'
  if (h >= 11 && h < 14) return 'noon'
  if (h >= 17 && h < 21) return 'night'
  return ''
}

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 今天该播什么节日动作。返回 {name, anim, kind}，都不是节日时返回 null
function occasionOf(cfg, date) {
  const c = (cfg && cfg.calendar) || {}
  const now = date || new Date()

  const lk = lunarKey(now)
  if (lk && c.festivalAnims && c.festivalAnims[lk]) {
    const names = c.festivalNames || {}
    return { name: names[lk] || '节日', anims: c.festivalAnims[lk], kind: 'festival' }
  }

  const sk = solarKey(now)
  if (c.solarAnims && c.solarAnims[sk]) {
    const names = c.solarNames || {}
    return { name: names[sk] || '节日', anims: c.solarAnims[sk], kind: 'festival' }
  }

  const season = seasonOf(now)
  if (c.seasonAnims && c.seasonAnims[season]) {
    const arr = c.seasonAnims[season]
    if (arr && arr.length) {
      return { name: SEASON_NAMES[season] || season, anims: arr, kind: 'season' }
    }
  }
  return null
}

// 渲染层待机时抽一个来播。过节的时候概率高，单纯应景的时候低
function occasionAnim(cfg, date) {
  const o = occasionOf(cfg, date)
  if (!o) return null
  const chance = ((cfg && cfg.calendar && cfg.calendar.chance) || {})[o.kind]
  const p = chance == null ? (o.kind === 'festival' ? 0.35 : 0.12) : chance
  if (Math.random() >= p) return null
  const anim = pick(o.anims)
  return anim ? { anim, name: o.name, kind: o.kind } : null
}

module.exports = { lunarKey, solarKey, seasonOf, slotOf, occasionOf, occasionAnim }
