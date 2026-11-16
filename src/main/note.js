'use strict'

// 递小纸条：你埋头干活的时候，隔一阵子递一张关怀便签（喝水 / 起身 / 护眼…）。
// 气泡在渲染层会切成黄色便签样式，比普通气泡更像「一张纸条」。
//
// 跟「冷落了来找你」相反：那个是全都 idle 了才来，这个是你在忙时才递——
// 你正认真干活，一张小纸条提醒你别把自己累坏，才叫关怀；你摸鱼时凑过来才是烦。

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 上次递纸条的时间放内存里：桌宠一关就重新计时，符合直觉
let lastAt = 0

// 纯判定，抽出来好自检：没在忙 / 没到间隔 / 关了 → 都不递
function shouldFire(cfg, last, busy, now) {
  const n = (cfg && cfg.note) || {}
  if (n.enabled === false) return false
  if (!busy) return false
  const every = n.everyMs || 1800000
  return !last || now - last >= every
}

function build(cfg, now) {
  const n = (cfg && cfg.note) || {}
  lastAt = now
  return {
    line: String(pick(n.lines) || '起来喝口水吧~'),
    anim: pick(n.anims) || null,
    label: n.label || '小纸条',
  }
}

// tick 里自动判定：有 agent 在忙且到点了才递
function watch(cfg, all, now) {
  const n = (cfg && cfg.note) || {}
  if (n.enabled === false) return null
  const list = Array.isArray(all) ? all : []
  const busy = list.some((a) => a && a.phase && a.phase !== 'idle')
  if (!shouldFire(cfg, lastAt, busy, now)) return null
  return build(cfg, now)
}

// 菜单里手动点「递张小纸条」：不看时间、不看忙闲，立刻递一张
function force(cfg, now) {
  const n = (cfg && cfg.note) || {}
  if (n.enabled === false) return null
  return build(cfg, now == null ? Date.now() : now)
}

module.exports = { watch, force, shouldFire }
