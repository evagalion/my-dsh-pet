'use strict'

// 作息动画：按「现在几点」和「连续干了多久」主动播一段，不用你去点菜单。
//
// 三条触发线：
//   早上 7~9 点        → 晨间刷牙（每天一次）
//   深夜 23~5 点还在跑 → 打瞌睡被惊醒（半小时冷却）
//   连续工作 1 小时    → 超大伸懒腰 + 喊你起来动一动（一小时冷却）
//
// 跟 mood.js 的「躺平 / 卡太久」一样由主进程驱动：渲染层只看得到合并后的档位，
// 看不到三家各自的状态，也不知道持续了多久。

const clampHour = (h) => ((h % 24) + 24) % 24
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 冷却只放在内存里：桌宠一关就没了，重启后重新计时，这符合直觉
let morningOn = ''
let lateFiredAt = 0
let sitFiredAt = 0
let workSince = 0
let idleSince = 0
// 本轮摸鱼里已经放过哪几档（下标），回去干活就清空，下次摸鱼从头来
const idleDone = new Set()

function watch(cfg, all, now) {
  const r = (cfg && cfg.routine) || {}
  if (r.enabled === false) return null

  const d = new Date(now)
  const h = clampHour(d.getHours())
  const list = Array.isArray(all) ? all : []
  const busy = list.some((a) => a && a.phase && a.phase !== 'idle')

  // 连续工作时长：只要还有一家在跑就一直累计，全摸鱼就清零。
  // 时间戳倒退（跨天、系统时间回拨）也要重置，不然算出负数就永远不触发了
  if (busy) {
    if (!workSince || now < workSince) workSince = now
  } else {
    workSince = 0
  }

  // 摸鱼时长（同上，倒退要重置）。idlePlay 的阶梯挂在它上面
  if (!busy && list.length) {
    if (!idleSince || now < idleSince) idleSince = now
  } else {
    idleSince = 0
    idleDone.clear()
  }

  // 越闲越放飞：先伸个懒腰，再自己找玩具。8 分钟那档的「原地小憩沉眠」
  // 在 mood.js 里（躺平），这里只管 8 分钟之前的两档，不跟它打架
  const steps = (r.idlePlay && r.idlePlay.steps) || []
  if (idleSince) {
    const min = (now - idleSince) / 60000
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      if (!s || !s.anims || !s.anims.length) continue
      if (idleDone.has(i)) continue
      if (min >= (s.afterMin || 0)) {
        idleDone.add(i)
        return {
          key: 'idlePlay',
          anim: pick(s.anims),
          line: pick(s.lines) || '',
          minutes: Math.round(min),
        }
      }
    }
  }

  // 深夜还在跑 —— 这条优先，凌晨两点的「该动一动了」不如「我不行了」
  const ln = r.lateNight || {}
  const lateFrom = ln.afterHour == null ? 23 : ln.afterHour
  const lateTo = ln.beforeHour == null ? 5 : ln.beforeHour
  const isLate = lateFrom > lateTo ? h >= lateFrom || h < lateTo : h >= lateFrom && h < lateTo
  if (isLate && busy && now - lateFiredAt > (ln.cooldownMs || 1800000)) {
    lateFiredAt = now
    return { key: 'lateNight', anim: ln.anim || '打瞌睡被惊醒', line: ln.line || '', minutes: 0 }
  }

  // 久坐：连续干了太久
  const ls = r.longSit || {}
  if (workSince && now - workSince >= (ls.afterMin || 60) * 60000) {
    if (now - sitFiredAt > (ls.cooldownMs || 3600000)) {
      sitFiredAt = now
      return {
        key: 'longSit',
        anim: ls.anim || '超大伸懒腰',
        line: ls.line || '',
        minutes: Math.round((now - workSince) / 60000),
      }
    }
  }

  // 早上起来刷个牙，一天只播一次
  const mo = r.morning || {}
  const hours = Array.isArray(mo.hours) ? mo.hours : [7, 9]
  const today = dayKey(d)
  if (h >= hours[0] && h < hours[1] && morningOn !== today) {
    morningOn = today
    return { key: 'morning', anim: mo.anim || '晨间刷牙', line: mo.line || '', minutes: 0 }
  }

  return null
}

module.exports = { watch }
