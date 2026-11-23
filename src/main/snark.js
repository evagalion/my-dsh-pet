'use strict'

// 毒舌实时吐槽 —— 比"被动冒泡"主动得多：它盯着你干的活，逮着机会就损你一句。
//
// 触发分两种：
//   1. 事件触发：agent 状态一变（尤其失败 / 长时间 working / 切任务）就精准吐槽一句，
//      用 holdUntil 压住状态机几秒，保证这句能被看见。
//   2. 定时吐槽：每隔一阵子（默认 6 分钟）从"看心情/看档位"的池子里随机冒一句，
//      纯属嘴欠，不需要事件。
//
// 文案按场景分池，越具体越好笑；跟现有 432 句 idleTexts 完全不重叠（那些是温柔碎碎念，
// 这里是带刺的吐槽）。纯函数（pickLine / sceneOf / shouldFire）抽出来好自检。

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

let lastEventAt = 0 // 上次事件吐槽的时刻，避免状态疯狂变化时刷屏
let lastIdleAt = 0 // 上次定时吐槽
let lastScene = '' // 上次场景，同一个场景连续出现时换一句

function cfgOf(cfg) {
  return (cfg && cfg.snark) || {}
}

// 从 agent 状态 + 上下文推断当前场景。返回场景 key 或 null。
// 优先级：失败 > 卡很久 > 切任务 > 深夜 > 长时间忙 > 摸鱼
function sceneOf(all, now, opts) {
  const o = opts || {}
  const list = Array.isArray(all) ? all : []
  const working = list.find((a) => a && a.phase === 'working')
  const err = list.find((a) => a && a.phase === 'error')
  const hour = new Date(now).getHours()

  if (err) return 'error'
  // 卡很久：外部把 mood 的 stuck 喂进来
  if (o.stuck) return 'stuck'
  // 深夜还在忙
  if (working && hour >= (o.lateHour || 23)) return 'late'
  // 长时间 working（外部喂分钟数）
  if (working && (o.workMin || 0) >= (o.longWorkMin || 45)) return 'longwork'
  // 刚切了任务
  if (working && o.justSwitched) return 'switch'
  // 全在摸鱼
  if (!working && !err) return 'idle'
  return null
}

function pickLine(cfg, scene, ctx) {
  const pools = cfgOf(cfg).pools || {}
  const raw = pools[scene]
  const lines = typeof raw === 'string' ? [raw] : raw || []
  if (!lines.length) return null
  const c = ctx || {}
  let line = pick(lines)
  if (!line) return null
  line = String(line)
    .replace('{agent}', c.agent || '它')
    .replace('{what}', c.what || '那个东西')
    .replace('{min}', String(c.min || 0))
  return line
}

// 纯判定：事件触发是否放行（开关开、不在冷却、场景有效）
function shouldFire(cfg, now, scene) {
  const s = cfgOf(cfg)
  if (s.enabled === false) return false
  if (!scene) return false
  if (now - lastEventAt < (s.eventCooldownMs || 90000)) return false
  return true
}

// 纯判定：定时嘴欠是否到点（且当前没在忙时不打扰——忙时交给事件触发）
function shouldIdleFire(cfg, now, busy, scene) {
  const s = cfgOf(cfg)
  if (s.enabled === false || s.idleEnabled === false) return false
  if (busy) return false // 忙着的时候不无厘头插话
  if (scene && scene !== 'idle') return false
  if (now - lastIdleAt < (s.idleEveryMs || 360000)) return false
  return true
}

// 事件入口：状态变化 / 失败 / 卡壳时调。返回 {line, scene, anim, holdMs} 或 null。
function onEvent(cfg, all, now, extra) {
  const e = extra || {}
  const scene = sceneOf(all, now, e)
  if (!shouldFire(cfg, now, scene)) return null
  lastEventAt = now
  // 同场景连着来就跳过这一轮，避免"同一个梗"连刷（下次别的场景能正常出）
  if (scene === lastScene && now - (e.lastAnyAt || 0) < (cfgOf(cfg).sameSceneSkipMs || 300000)) {
    return null
  }
  lastScene = scene
  const ctx = {
    agent: e.agent || '',
    what: e.what || '',
    min: e.min || 0,
  }
  const line = pickLine(cfg, scene, ctx)
  if (!line) return null
  const s = cfgOf(cfg)
  return {
    line,
    scene,
    anim: pick((s.anims || {})[scene]) || null,
    holdMs: s.holdMs || 5200,
  }
}

// 定时嘴欠入口。返回 {line, scene, anim, holdMs} 或 null。
function onIdleTick(cfg, all, now) {
  const busy = (Array.isArray(all) ? all : []).some((a) => a && a.phase && a.phase !== 'idle')
  if (!shouldIdleFire(cfg, now, busy, 'idle')) return null
  lastIdleAt = now
  const line = pickLine(cfg, 'idle', {})
  if (!line) return null
  const s = cfgOf(cfg)
  return {
    line,
    scene: 'idle',
    anim: pick((s.anims || {}).idle) || null,
    holdMs: s.holdMs || 5200,
  }
}

function snapshot(cfg) {
  const s = cfgOf(cfg)
  const scenes = Object.keys(s.pools || {})
  const totalLines = scenes.reduce((n, k) => {
    const v = (s.pools || {})[k]
    return n + (Array.isArray(v) ? v.length : v ? 1 : 0)
  }, 0)
  return { enabled: s.enabled !== false, scenes, totalLines }
}

module.exports = { sceneOf, pickLine, shouldFire, shouldIdleFire, onEvent, onIdleTick, snapshot }
