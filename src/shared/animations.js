'use strict'

// 素材分类。主进程用它造右键菜单，渲染层用它跑动画链 —— 两边共用同一份，
// 免得菜单里能点到的动画，实际上链里播不出来。

const MOVE_SET = new Set(['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'])

function classify(assets, cfg) {
  const p = {
    idle: [],
    turn: [],
    move: [],
    fun: [],
    whisper: [],
    clicks: [],
    drag: [],
    balance: [],
    phase: {},
  }

  const byAnim = {}
  for (const k of Object.keys(cfg.phases || {})) byAnim[cfg.phases[k].anim] = k
  const idleSet = new Set(cfg.idleAnims || [])

  for (const a of assets) {
    if (byAnim[a]) {
      p.phase[byAnim[a]] = a
    } else if (a.startsWith('余额-')) {
      p.balance.push(a)
    } else if (a.startsWith('碎碎念-')) {
      p.whisper.push(a)
    } else if (a.startsWith('点击回应-')) {
      p.clicks.push(a)
    } else if (a === '被鼠标拖拽悬空反馈') {
      p.drag.push(a)
    } else if (idleSet.has(a) || a.startsWith('待机')) {
      p.idle.push(a)
    } else if (a === '东张西望') {
      p.turn.push(a)
    } else if (MOVE_SET.has(a)) {
      p.move.push(a)
    } else {
      p.fun.push(a)
    }
  }

  if (!p.idle.length && p.fun.length) p.idle.push(p.fun[0])

  for (const k of Object.keys(p)) {
    if (Array.isArray(p[k])) p[k].sort((a, b) => a.localeCompare(b, 'zh'))
  }
  return p
}

// 菜单用的分组：趣味动画太多，切成每 24 个一组
const GROUP_LABELS = {
  idle: '待机',
  move: '走路',
  clicks: '点击回应',
  whisper: '碎碎念',
  balance: '余额',
  turn: '转身',
}

function menuGroups(pools, cfg) {
  const phaseLabels = {}
  for (const k of Object.keys(cfg.phases || {})) phaseLabels[cfg.phases[k].anim] = cfg.phases[k].label || k

  const groups = []

  const phaseItems = Object.keys(pools.phase).map((k) => ({
    name: pools.phase[k],
    label: phaseLabels[pools.phase[k]] || k,
  }))
  if (phaseItems.length) groups.push({ label: '工作状态', items: phaseItems })

  for (const key of ['idle', 'move', 'clicks', 'whisper', 'balance', 'turn']) {
    if (!pools[key] || !pools[key].length) continue
    groups.push({ label: GROUP_LABELS[key], items: pools[key].map((n) => ({ name: n, label: n })) })
  }

  const fun = pools.fun || []
  const CHUNK = 24
  for (let i = 0; i < fun.length; i += CHUNK) {
    groups.push({
      label: fun.length > CHUNK ? `趣味 ${Math.floor(i / CHUNK) + 1}` : '趣味',
      items: fun.slice(i, i + CHUNK).map((n) => ({ name: n, label: n })),
    })
  }

  return groups
}

module.exports = { classify, menuGroups }
