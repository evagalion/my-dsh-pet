'use strict'

// 成就 / 里程碑：达成某个条件就播一段大招素材（蓝鲸现世、凭空生花、动物环绕…）。
//
// 这些素材一直混在 77 段的随机池里，随机播到的概率极低，等于白放着。
// 判定需要的四份数据全都是现成的：
//   streak   连胜数          ← mood.trailingSuccesses
//   dayTotal 今日总轮次      ← digest.today().n
//   dayOk    今日成功轮次    ← digest.today().ok
//   coins    小金库余额      ← coins.value
//   bond     亲密度          ← mood.snapshot().bond
// 所以这个模块自己不记流水，只记「哪些已经解锁过」。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

function file() {
  return path.join(app.getPath('userData'), 'achievements.json')
}

// { unlocked: { key: 解锁时间戳 } }
let st = null

function load() {
  if (st) return st
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8'))
    st = { unlocked: o.unlocked && typeof o.unlocked === 'object' ? o.unlocked : {} }
  } catch (e) {
    st = { unlocked: {} }
  }
  return st
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(load()), 'utf8')
  } catch (e) {
    /* 存不下就算了，这次成就照样弹，只是重启后要再达成一次 */
  }
}

// 把四类判定所需的数字凑齐。传进来是因为这些值分散在 mood / coins / digest 里，
// 让调用方一次性喂进来，省得这里再反向依赖那几个模块
function gauge(ctx, type) {
  const c = ctx || {}
  switch (type) {
    case 'streak':
      return c.streak || 0
    case 'dayTotal':
      return c.dayTotal || 0
    case 'dayOk':
      return c.dayOk || 0
    case 'coins':
      return c.coins || 0
    case 'bond':
      return c.bond || 0
    default:
      return 0
  }
}

// 检查有没有新达成的。返回新解锁的成就列表（一般 0 或 1 个）
function check(cfg, ctx) {
  const a = (cfg && cfg.achievements) || {}
  if (a.enabled === false) return []
  const items = a.items || []
  const got = []
  const now = Date.now()
  for (const it of items) {
    if (!it || !it.key) continue
    if (load().unlocked[it.key]) continue
    if (gauge(ctx, it.type) >= (it.at || 0)) {
      load().unlocked[it.key] = now
      got.push(it)
    }
  }
  if (got.length) save()
  return got
}

// 菜单用的进度：「成就（2/5）」
function snapshot(cfg) {
  const a = (cfg && cfg.achievements) || {}
  const items = a.items || []
  const done = items.filter((it) => it && load().unlocked[it.key]).length
  return {
    enabled: a.enabled !== false,
    done,
    total: items.length,
    unlocked: items.filter((it) => it && load().unlocked[it.key]).map((it) => ({
      key: it.key,
      label: it.label,
    })),
  }
}

module.exports = { check, snapshot }
