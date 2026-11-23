'use strict'

// 底部小水族馆 —— 放置养成。一条贴屏幕底边的透明窗口，几只小鱼在里头游。
//
// 玩法循环：
//   - 小鱼随时间"长大"（growth 按时间戳现算，离线也长，但有上限）
//   - 长大到成年会持续"产金币"（同样按时间现算，不用后台计时器）
//   - 你点「撒鱼食」→ 全场生长速度短暂加成 + 立即产一小笔金币（有冷却）
//   - 攒够金币解锁新鱼种（不同 emoji/颜色），解锁的鱼会出现在水族馆里
//   - 升级"水质/鱼缸"提升产币和容量上限
//
// 存档 userData/aquarium.json，只存「上次结算时间 + 金币 + 已解锁鱼种 + 升级等级」。
// 所有随时间变化的量都按 now - lastAt 现算，跟 feed/mood 一个套路。纯函数好自检。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// 鱼种图鉴：cost 为解锁价，rate 为每分钟产币，color 用于渲染
const SPECIES = [
  { id: 'fish', name: '小蓝鱼', emoji: '🐟', cost: 0, rate: 1.2, color: '#5aa9e6' },
  { id: 'tropical', name: '热带鱼', emoji: '🐠', cost: 120, rate: 2.0, color: '#e8894a' },
  { id: 'puffer', name: '河豚', emoji: '🐡', cost: 320, rate: 3.2, color: '#e0b84a' },
  { id: 'shark', name: '小鲨鱼', emoji: '🦈', cost: 800, rate: 5.5, color: '#6a8fa8' },
  { id: 'whale', name: '鲸鱼宝宝', emoji: '🐳', cost: 1800, rate: 9.0, color: '#5b7fd4' },
]

function file() {
  return path.join(app.getPath('userData'), 'aquarium.json')
}

// { coins, unlocked:[id], growth, level, lastAt, fedAt }
let st = null

function load() {
  if (st) return st
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    st = {
      coins: Number.isFinite(o.coins) ? o.coins : 0,
      unlocked: Array.isArray(o.unlocked) && o.unlocked.length ? o.unlocked : ['fish'],
      growth: Number.isFinite(o.growth) ? o.growth : 0,
      level: Number.isFinite(o.level) ? o.level : 1,
      lastAt: Number(o.lastAt) || Date.now(),
      fedAt: Number(o.fedAt) || 0,
    }
  } catch (e) {
    st = { coins: 0, unlocked: ['fish'], growth: 0, level: 1, lastAt: Date.now(), fedAt: 0 }
  }
  return st
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(load()), 'utf8')
  } catch (e) {
    /* 存不下不影响本次 */
  }
}

function cfgOf(cfg) {
  return (cfg && cfg.aquarium) || {}
}

function speciesOf(id) {
  return SPECIES.find((s) => s.id === id) || null
}

function speciesList() {
  return SPECIES
}

// 纯函数：算一段时间里的产出。growth 上限 100；产币 = Σ 已解锁鱼种 rate × 分钟数 × 等级系数。
function accrue(state, minutes, cfg) {
  const a = cfgOf(cfg)
  const mins = Math.max(0, minutes)
  const growPerMin = a.growPerMin || 4
  const growth = clamp((state.growth || 0) + mins * growPerMin, 0, 100)
  const unlocked = Array.isArray(state.unlocked) ? state.unlocked : ['fish']
  let rate = 0
  for (const id of unlocked) {
    const sp = speciesOf(id)
    if (sp) rate += sp.rate
  }
  const levelMul = 1 + ((state.level || 1) - 1) * (a.levelBonus || 0.35)
  const coins = Math.floor(rate * mins * levelMul)
  return { growth, coins, rate }
}

// 结算：把上次结算到现在的时间一次性算进来，写回存档。返回本次增量。
function settle(cfg, now) {
  const ts = Number(now) || Date.now()
  const s = load()
  const mins = Math.max(0, (ts - (s.lastAt || ts)) / 60000)
  const r = accrue(s, mins, cfg)
  s.growth = r.growth
  s.coins += r.coins
  s.lastAt = ts
  save()
  return { ...r, coinsTotal: s.coins }
}

// 撒鱼食：冷却到了就给一笔即时金币 + 生长加成，返回 {ok, coins, waitSec}。
function feed(cfg, now) {
  const a = cfgOf(cfg)
  const ts = Number(now) || Date.now()
  const s = load()
  const cd = a.feedCooldownMs || 30000
  const wait = s.fedAt ? cd - (ts - s.fedAt) : 0
  if (wait > 0) return { ok: false, waitSec: Math.ceil(wait / 1000) }
  settle(cfg, ts)
  const gain = Math.max(2, Math.round((a.feedCoinBase || 8) * (1 + (s.level - 1) * 0.3)))
  s.coins += gain
  s.growth = clamp(s.growth + (a.feedGrowth || 12), 0, 100)
  s.fedAt = ts
  save()
  return { ok: true, coins: gain, coinsTotal: s.coins }
}

// 解锁鱼种。返回 {ok, species, reason}。
function unlock(cfg, id) {
  const sp = speciesOf(id)
  if (!sp) return { ok: false, reason: '没有这种鱼' }
  const s = load()
  if (s.unlocked.indexOf(id) >= 0) return { ok: false, reason: '已经解锁啦' }
  if (s.coins < sp.cost) return { ok: false, reason: `还差 ${sp.cost - s.coins} 枚` }
  s.coins -= sp.cost
  s.unlocked.push(id)
  save()
  return { ok: true, species: sp, coinsTotal: s.coins }
}

// 升级鱼缸：花钱提升等级（产币系数）。返回 {ok, level, cost, reason}。
function upgrade(cfg) {
  const a = cfgOf(cfg)
  const s = load()
  const max = a.maxLevel || 5
  if (s.level >= max) return { ok: false, reason: '鱼缸已经满级啦' }
  const cost = (a.upgradeCostBase || 150) * s.level
  if (s.coins < cost) return { ok: false, reason: `升级还差 ${cost - s.coins} 枚` }
  s.coins -= cost
  s.level += 1
  save()
  return { ok: true, level: s.level, cost, coinsTotal: s.coins }
}

// 给渲染层的完整快照：结算一次，带上可展示的所有信息。
function snapshot(cfg, now) {
  const a = cfgOf(cfg)
  if (a.enabled === false) return { enabled: false }
  const delta = settle(cfg, now)
  const s = load()
  const ts = Number(now) || Date.now()
  const cd = a.feedCooldownMs || 30000
  return {
    enabled: true,
    coins: s.coins,
    growth: Math.round(s.growth),
    level: s.level,
    maxLevel: a.maxLevel || 5,
    unlocked: s.unlocked.slice(),
    species: SPECIES.map((sp) => ({ ...sp, owned: s.unlocked.indexOf(sp.id) >= 0 })),
    feedWaitSec: s.fedAt ? Math.max(0, Math.ceil((cd - (ts - s.fedAt)) / 1000)) : 0,
    earned: delta.coins,
    upCost: (a.upgradeCostBase || 150) * s.level,
  }
}

module.exports = {
  settle, feed, unlock, upgrade, snapshot,
  accrue, speciesOf, speciesList, load,
}
