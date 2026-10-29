'use strict'

// 小金库：成功一轮赚币，失败扣币，攒够就拆个礼物。
//
// 素材里本来就有 6 段「余额-」动画（分文不剩 / 袋空如洗 / 数金皱眉 / 钱袋如常 /
// 金袋叮当 / 钱袋满溢），一直没接线，这里按余额分档把它们用起来。
//
// 币是累计的，**不随时间衰减**——跟饱腹度、亲密度不一样，攒下来的就是攒下来的。
// 所以存档只需要一个数，连时间戳都不用存。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function file() {
  return path.join(app.getPath('userData'), 'coins.json')
}

// { total, giftAt: 上次庆祝时攒够的第几个 100 }
let st = null

function load() {
  if (st) return st
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    st = { total: Number.isFinite(o.total) ? o.total : null, giftAt: Number(o.giftAt) || 0 }
  } catch (e) {
    st = { total: null, giftAt: 0 }
  }
  return st
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(load()), 'utf8')
  } catch (e) {
    /* 存不下就算了，不影响这一次记账 */
  }
}

function cfgOf(cfg) {
  return (cfg && cfg.coins) || {}
}

function value(cfg) {
  const c = cfgOf(cfg)
  if (c.enabled === false) return null
  const cur = load().total
  return cur == null ? clamp(c.initial == null ? 30 : c.initial, 0, 999999) : clamp(cur, 0, 999999)
}

function tierOf(cfg, v) {
  const tiers = cfgOf(cfg).tiers || []
  let hit = null
  for (const t of tiers) if (v >= (t.at || 0)) hit = t
  return hit
}

// 记一笔。kind 只吃 success / error，且调用方（index.js）已经去重过，
// 同一个结果不会重复加钱。
// 返回 {total, tier, gift}：gift 为 true 时上层该播一段拆礼物
function note(cfg, kind) {
  const c = cfgOf(cfg)
  if (c.enabled === false) return null
  const cur = value(cfg)
  if (cur == null) return null
  const delta = kind === 'success' ? (c.earnPerSuccess || 3) : -(c.losePerError || 2)
  const after = clamp(cur + delta, 0, 999999)

  // 每攒够一个 giftAt 庆祝一次，用「第几个」记住，避免同一档反复播
  const per = c.giftAt || 100
  const nth = Math.floor(after / per)
  let gift = false
  if (nth > (load().giftAt || 0)) {
    load().giftAt = nth
    gift = true
  }

  load().total = after
  save()
  return { total: after, delta, tier: tierOf(cfg, after), gift }
}

// 菜单用的快照
function snapshot(cfg) {
  const v = value(cfg)
  if (v == null) return { enabled: false, total: 0, tier: null }
  return { enabled: true, total: Math.round(v), tier: tierOf(cfg, v) }
}

module.exports = { value, tierOf, note, snapshot }
