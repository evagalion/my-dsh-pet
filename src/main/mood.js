'use strict'

// 心情 + 亲密度 + 两个「主动开口」的时机（一起摸鱼 / 卡太久）。
//
// 心情：把最近一段时间里的成功/失败记成流水，成功 +1、失败 -1.5，
//      加总出 mood；连续失败到阈值就进入「赌气」状态，这段时间里戳它会扭头不理。
// 亲密度：戳它、喂它都涨，长期不理就掉。跟饱腹度同一个套路——
//      存档只放「值 + 上次互动时间」，读取时按过去了多久现算衰减，不跑计时器。
//
// 两个主动开口的时机都靠状态持续时长判断，所以计时器放在这里而不是渲染层：
// 渲染层只知道「当前档位」，看不到三家各自的状态。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function file() {
  return path.join(app.getPath('userData'), 'mood.json')
}

// { bond: {value, at}, outcomes: [{t, kind}] }
let st = null

function load() {
  if (st) return st
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    st = {
      bond: o.bond && Number.isFinite(o.bond.value) ? o.bond : null,
      outcomes: Array.isArray(o.outcomes) ? o.outcomes : [],
    }
  } catch (e) {
    st = { bond: null, outcomes: [] }
  }
  return st
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(load()), 'utf8')
  } catch (e) {
    /* 存不下就算了，不影响当前这次互动 */
  }
}

function cfgOf(cfg, key) {
  return ((cfg && cfg[key]) || {})
}

// ---- 心情 ----

let lastPhase = '' // 同一次结果只记一次，别因为重复推送把失败数刷上去

// 返回 true 表示真的新记了一笔。小金库和每日回顾都挂在这同一次去重上，
// 不去重的话每秒一次的状态推送会把钱和轮次都刷爆
function note(cfg, phase) {
  if (phase !== 'success' && phase !== 'error') {
    lastPhase = phase
    return false
  }
  if (phase === lastPhase) return false
  lastPhase = phase

  const s = load()
  const now = Date.now()
  const win = cfgOf(cfg, 'mood').windowMs || 1800000
  s.outcomes = s.outcomes.filter((o) => now - o.t < win)
  s.outcomes.push({ t: now, kind: phase })
  if (s.outcomes.length > 200) s.outcomes = s.outcomes.slice(-200)
  save()
  return true
}

// 末尾连续失败了几次（中间夹了成功就断）
function trailingErrors(cfg, now) {
  const win = cfgOf(cfg, 'mood').windowMs || 1800000
  const outs = load()
    .outcomes.filter((o) => now - o.t < win)
    .sort((a, b) => a.t - b.t)
  let n = 0
  for (let i = outs.length - 1; i >= 0; i--) {
    if (outs[i].kind === 'error') n++
    else break
  }
  return n
}

function scoreOf(cfg, now) {
  const win = cfgOf(cfg, 'mood').windowMs || 1800000
  let score = 0
  for (const o of load().outcomes) {
    if (now - o.t >= win) continue
    score += o.kind === 'success' ? 1 : -1.5
  }
  return score
}

function isSulking(cfg, now) {
  const m = cfgOf(cfg, 'mood')
  if (trailingErrors(cfg, now) < (m.sulkErrors || 3)) return false
  // 赌气只在最后一次失败之后的一段时间里有效，之后自己缓过来
  const outs = load().outcomes.filter((o) => o.kind === 'error')
  if (!outs.length) return false
  const lastErr = Math.max(...outs.map((o) => o.t))
  return now - lastErr < (m.sulkMs || 240000)
}

function moodKey(cfg, score) {
  const m = cfgOf(cfg, 'mood')
  const happy = m.happyAt == null ? 1 : m.happyAt
  const sad = m.sadAt == null ? -1 : m.sadAt
  if (score >= happy) return 'happy'
  if (score <= sad) return 'sad'
  return 'calm'
}

// ---- 亲密度 ----

function bondValue(cfg, now) {
  const b = cfgOf(cfg, 'bond')
  if (b.enabled === false) return null
  const cur = load().bond
  if (!cur) return clamp(b.initial == null ? 20 : b.initial, 0, 100)
  const perHour = b.decayPerHour == null ? 0.6 : b.decayPerHour
  const hours = Math.max(0, (now - (cur.at || now)) / 3600000)
  return clamp(cur.value - hours * perHour, 0, 100)
}

// 戳一下 / 喂一口都涨一点。at 一并刷新，等于「又理我了」，衰减从头算
function bumpBond(cfg, kind) {
  const b = cfgOf(cfg, 'bond')
  if (b.enabled === false) return null
  const now = Date.now()
  const gain = (b.gains || {})[kind] || 1
  const before = bondValue(cfg, now)
  const after = clamp(before + gain, 0, 100)
  load().bond = { value: after, at: now }
  save()
  return { before: Math.round(before), after: Math.round(after) }
}

function bondLevel(cfg, value) {
  const levels = cfgOf(cfg, 'bond').levels || []
  let hit = null
  for (const lv of levels) {
    if (value >= (lv.at || 0)) hit = lv
  }
  return hit
}

// ---- 两个主动开口的时机 ----
// 都由 index.js 每次轮询喂进三家各自的状态来驱动

let allIdleSince = 0
let lieFiredAt = 0
let stuckKey = ''
let stuckSince = 0
let stuckFiredAt = 0

function watch(cfg, all, now) {
  const m = cfgOf(cfg, 'mood')
  const out = { lieDown: false, stuck: null }
  const list = Array.isArray(all) ? all : []

  // 三家都在摸鱼 → 它也跟着躺
  const busy = list.some((a) => a && a.phase && a.phase !== 'idle')
  if (busy) {
    allIdleSince = 0
  } else if (!allIdleSince) {
    allIdleSince = now
  }
  if (allIdleSince) {
    const min = (now - allIdleSince) / 60000
    const cool = m.lieDownCooldownMs || 1200000
    if (min >= (m.lieDownAfterMin || 8) && now - lieFiredAt > cool) {
      lieFiredAt = now
      out.lieDown = true
    }
  }

  // 某个 agent 卡在同一轮里太久了
  const cur = list.find((a) => a && a.phase === 'working')
  if (!cur) {
    // 没有在工作的就清掉，新一轮从头计时（不然上一个任务的时长会算到下一个头上）
    stuckKey = ''
    stuckSince = 0
    stuckFiredAt = 0
  } else {
    const key = `${cur.source}|${cur.project || cur.title || ''}`
    if (key !== stuckKey) {
      stuckKey = key
      stuckSince = now
      stuckFiredAt = 0
    }
    const min = (now - stuckSince) / 60000
    const repeat = m.stuckRepeatMs || 300000
    if (min >= (m.stuckAfterMin || 5) && now - stuckFiredAt > repeat) {
      stuckFiredAt = now
      out.stuck = {
        minutes: Math.round(min),
        source: cur.source,
        what: cur.project || cur.title || '',
      }
    }
  }

  return out
}

// ---- 对外快照 ----

function snapshot(cfg) {
  const now = Date.now()
  const m = cfgOf(cfg, 'mood')
  if (m.enabled === false) {
    return { mood: 'calm', score: 0, sulking: false, bond: null, level: null, enabled: false }
  }
  const score = scoreOf(cfg, now)
  const bond = bondValue(cfg, now)
  const lv = bond == null ? null : bondLevel(cfg, bond)
  return {
    enabled: true,
    mood: moodKey(cfg, score),
    score: Math.round(score * 10) / 10,
    sulking: isSulking(cfg, now),
    bond: bond == null ? null : Math.round(bond),
    level: lv ? { key: lv.key, label: lv.label } : null,
  }
}

module.exports = { note, watch, snapshot, bumpBond, bondValue, bondLevel, isSulking }
