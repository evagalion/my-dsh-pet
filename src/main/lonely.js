'use strict'

// 冷落太久，它主动来找你。
//
// 亲密度一直是单向的：不理它就往下掉，但它没有任何主动挽回的动作。
// 这很不对称 —— 你怠慢它，它只是默默变冷淡，不会设法引起你注意。
// 这里补上另一端：冷落够了，它自己敲桌子 / 吐泡泡来提醒你它还在。
//
// 「原地敲击桌面互动」「鲸鱼吐泡泡特效」这两段素材之前完全没接线，
// 恰好就是「主动发出动静」的样子。

const mood = require('./mood')

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 冷却只放内存里：桌宠一关就没了，重启后重新计时，这符合直觉
let bootAt = 0
let firedAt = 0

function watch(cfg, all, now) {
  const l = (cfg && cfg.lonely) || {}
  if (l.enabled === false) return null
  if (!bootAt) bootAt = now

  const list = Array.isArray(all) ? all : []
  // 只要有 agent 在忙就不来打扰。你在干活的时候它凑过来，是烦不是可爱
  if (list.some((a) => a && a.phase && a.phase !== 'idle')) return null

  if (now - firedAt < (l.cooldownMs || 1500000)) return null

  // 取「本次开机」和「上次理我」里**较晚**的那个作为起算点：
  // 刚开机就扑上来太吵，得是这次运行里真的冷落了它这么久才算。
  // lastBondAt 就是亲密度衰减的起算时刻，戳一下喂一口都会刷新
  const since = Math.max(bootAt, mood.lastBondAt() || 0)
  if (now - since < (l.afterMs || 2700000)) return null

  const bond = mood.bondValue(cfg, now)
  const lv = bond == null ? null : mood.bondLevel(cfg, bond)

  firedAt = now
  return {
    anim: pick(l.anims) || '鲸鱼吐泡泡特效',
    // 台词里可以带当前亲密度档位，让「冷落」的后果看得见
    line: String(pick(l.lines) || '喂，理理我嘛…').replace('{level}', lv ? lv.label : ''),
    bond: bond == null ? null : Math.round(bond),
    level: lv ? lv.label : null,
  }
}

module.exports = { watch }
