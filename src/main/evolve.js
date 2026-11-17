'use strict'

// 羁绊进化：把亲密度的 5 档当成 5 个形态。
//
// 设计取舍：不另造一套经验值。mood.js 里已经有会随时间衰减的 bond，
// 再建一个「进化经验」就会出现两套养成数值互相打架（喂一次到底涨哪个？）。
// 这里直接读 mood.bondValue() / mood.bondLevel()，只额外记「哪几档解锁过」。
//
// 存档 evolve.json 只放 { seen, evolvedAt }：
//   - seen：解锁过的档位 key 列表，决定菜单里的 ✓ 和「新形态」判定
//   - evolvedAt：每档首次达成的时间，纯展示

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const mood = require('./mood')

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

function file() {
  return path.join(app.getPath('userData'), 'evolve.json')
}

let st = null

function load() {
  if (st) return st
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    st = {
      seen: Array.isArray(o.seen) ? o.seen.filter((x) => typeof x === 'string') : [],
      evolvedAt: o.evolvedAt && typeof o.evolvedAt === 'object' ? o.evolvedAt : {},
    }
  } catch (e) {
    st = { seen: [], evolvedAt: {} }
  }
  return st
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(load()), 'utf8')
  } catch (e) {
    /* 存不下就算了，不影响这次演出 */
  }
}

function levelsOf(cfg) {
  const b = (cfg && cfg.bond) || {}
  return Array.isArray(b.levels) ? b.levels : []
}

function rankOf(cfg, key) {
  return levelsOf(cfg).findIndex((l) => l.key === key)
}

function formOf(cfg, key) {
  const e = (cfg && cfg.evolve) || {}
  return (e.forms || {})[key] || null
}

function unlockedCount(cfg, seen) {
  const s = new Set(seen || [])
  return levelsOf(cfg).filter((l) => s.has(l.key)).length
}

// 当前形态（只读，不写存档）。bond 关闭时返回 enabled:false。
function snapshot(cfg) {
  const e = (cfg && cfg.evolve) || {}
  if (e.enabled === false || ((cfg && cfg.bond) || {}).enabled === false) {
    return { enabled: false, unlocked: 0, total: levelsOf(cfg).length, seen: [] }
  }
  const value = mood.bondValue(cfg, Date.now())
  const lv = value == null ? null : mood.bondLevel(cfg, value)
  const levels = levelsOf(cfg)
  const key = lv ? lv.key : levels.length ? levels[0].key : null
  const f = formOf(cfg, key)
  const seen = load().seen.slice()
  return {
    enabled: true,
    levelKey: key,
    levelLabel: lv ? lv.label : '',
    formLabel: f && f.formLabel ? f.formLabel : lv ? lv.label : '',
    perkText: f && f.perkText ? f.perkText : '',
    anim: f ? pick(f.anims) : null,
    line: f ? pick(f.lines) : '',
    rank: rankOf(cfg, key),
    seen,
    unlocked: unlockedCount(cfg, seen),
    total: levels.length,
  }
}

// 存了才算解锁过。返回 true 表示这次之前从没见过。
function fresh(cfg) {
  return load().seen.length === 0
}

function eventOf(cfg, lv) {
  const e = (cfg && cfg.evolve) || {}
  const f = formOf(cfg, lv.key) || {}
  const s = load()
  return {
    levelKey: lv.key,
    levelLabel: lv.label || '',
    formLabel: f.formLabel || lv.label || '新形态',
    line: pick(f.lines) || pick(e.evolveLines) || '我好像…变厉害了？',
    perkText: f.perkText || '',
    anim: pick(f.anims) || pick(e.evolveAnims) || null,
    unlocked: unlockedCount(cfg, s.seen),
    total: levelsOf(cfg).length,
  }
}

// 亲密度涨之后调：当前档位比已记录的最高档更高 → 进化演出 + 记账。
// 中间跳过的档一并补进 seen（亲密度可以一次涨很多，配置也可能改）。
// opts.silent：开机静默同步时不返回事件，避免每次启动都弹演出。
function check(cfg, opts) {
  const e = (cfg && cfg.evolve) || {}
  if (e.enabled === false || ((cfg && cfg.bond) || {}).enabled === false) return null
  const value = mood.bondValue(cfg, Date.now())
  if (value == null) return null
  const lv = mood.bondLevel(cfg, value)
  if (!lv) return null

  const s = load()
  const rank = rankOf(cfg, lv.key)
  let maxSeen = -1
  for (const k of s.seen) maxSeen = Math.max(maxSeen, rankOf(cfg, k))
  if (rank <= maxSeen) return null

  const levels = levelsOf(cfg)
  for (let i = 0; i <= rank; i++) {
    const key = levels[i] && levels[i].key
    if (key && !s.seen.includes(key)) s.seen.push(key)
  }
  s.evolvedAt[lv.key] = Date.now()
  save()
  if (opts && opts.silent) return null
  const ev = eventOf(cfg, lv)
  ev.newForm = true
  return ev
}

// 菜单手动「回看当前形态」：不写存档，仅返回演出信息
function replay(cfg) {
  const e = (cfg && cfg.evolve) || {}
  if (e.enabled === false) return null
  const snap = snapshot(cfg)
  if (!snap.enabled || !snap.levelKey) return null
  const lv = levelsOf(cfg).find((l) => l.key === snap.levelKey)
  if (!lv) return null
  const ev = eventOf(cfg, lv)
  ev.newForm = false
  return ev
}

// 自检用：直接造指定档位的事件，不碰存档
function preview(cfg, key) {
  const lv = levelsOf(cfg).find((l) => l.key === key)
  return lv ? eventOf(cfg, lv) : null
}

module.exports = { snapshot, fresh, check, replay, preview, formOf, levelsOf, unlockedCount }
