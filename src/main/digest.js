'use strict'

// 每日回顾：按天记流水，下班时告诉你今天跑了几轮、成率如何、最折腾的是哪个项目。
//
// 心情记的是「最近 30 分钟顺不顺」（有窗口、会过期），这里记的是「今天一整天干了多少」
// （按天分桶、保留 7 天）。两者数据源相同，都是每次状态推送里的终态，但用途不同。
//
// 只记 success / error 两个终态，且由调用方（index.js）去重后喂进来，
// 同一个结果不会重复计数。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

function file() {
  return path.join(app.getPath('userData'), 'digest.json')
}

// { days: { '2026-10-29': {n, ok, bad, projects: {名称: 次数}, firstAt, lastAt} }, firedOn }
let st = null

function load() {
  if (st) return st
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    st = { days: o.days && typeof o.days === 'object' ? o.days : {}, firedOn: o.firedOn || '' }
  } catch (e) {
    st = { days: {}, firedOn: '' }
  }
  return st
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(load()), 'utf8')
  } catch (e) {
    /* 记不下就算了，不影响桌宠 */
  }
}

function cfgOf(cfg) {
  return (cfg && cfg.digest) || {}
}

function dayOf(cfg, key) {
  const s = load()
  if (!s.days[key]) s.days[key] = { n: 0, ok: 0, bad: 0, projects: {}, firstAt: 0, lastAt: 0 }
  return s.days[key]
}

// 记一轮结果。project 用来统计「最忙的是哪个项目」
function note(cfg, phase, project) {
  const d = cfgOf(cfg)
  if (d.enabled === false) return null
  if (phase !== 'success' && phase !== 'error') return null

  const now = Date.now()
  const key = dayKey(new Date(now))
  const day = dayOf(cfg, key)
  day.n++
  if (phase === 'success') day.ok++
  else day.bad++
  if (!day.firstAt) day.firstAt = now
  day.lastAt = now

  const name = String(project || '').trim()
  if (name) day.projects[name] = (day.projects[name] || 0) + 1

  // 只留最近几天，别让存档无限长
  const keep = d.keepDays || 7
  const keys = Object.keys(load().days).sort()
  while (keys.length > keep) delete load().days[keys.shift()]

  save()
  return day
}

// 今天的数据。没数据返回 null（菜单据此不显示）
function today(cfg) {
  const d = cfgOf(cfg)
  if (d.enabled === false) return null
  const day = load().days[dayKey(new Date())]
  if (!day || !day.n) return null
  const top = Object.keys(day.projects).sort((a, b) => day.projects[b] - day.projects[a])[0] || ''
  return { n: day.n, ok: day.ok, bad: day.bad, top, firstAt: day.firstAt, lastAt: day.lastAt }
}

// 播报台词。按成功率和忙碌程度挑一句
function line(cfg) {
  const t = today(cfg)
  const lines = cfgOf(cfg).lines || {}
  if (!t) return '今天还没跑过呢，摸了一整天鱼~'
  const fill = (s) =>
    String(s)
      .replace('{n}', t.n)
      .replace('{ok}', t.ok)
      .replace('{bad}', t.bad)
      .replace('{top}', t.top || '没记住')

  // 一轮都没跑满 3 次就别念了，听着像在嘲讽
  if (t.n < 3) return fill(lines.quiet || '今天一共 {n} 轮，还挺闲的~')
  const rate = t.ok / t.n
  return fill(rate >= 0.7 ? lines.good || '今天跑了 {n} 轮，收工啦' : lines.bad || '今天 {n} 轮里挂了 {bad} 个')
}

// 到了下班点、今天有数据、且还没播过 → 该播了
function shouldFire(cfg, now) {
  const d = cfgOf(cfg)
  if (d.enabled === false) return false
  const key = dayKey(new Date(now))
  const s = load()
  if (s.firedOn === key) return false
  const day = s.days[key]
  if (!day || day.n < 1) return false
  return new Date(now).getHours() >= (d.atHour == null ? 18 : d.atHour)
}

function markFired(cfg, now) {
  load().firedOn = dayKey(new Date(now))
  save()
}

module.exports = { note, today, line, shouldFire, markFired }
