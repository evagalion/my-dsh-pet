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

  // 每档可以配多段轮换（phases.x.anims 数组），只配一段就退化成原来的单段行为。
  // 素材不存在的话直接丢掉——配置里写错名字不会让菜单出现点不动的项
  const phases = cfg.phases || {}
  const assetSet = new Set(assets)
  for (const k of Object.keys(phases)) {
    const one = Array.isArray(phases[k].anims) && phases[k].anims.length
      ? phases[k].anims.slice()
      : phases[k].anim
        ? [phases[k].anim]
        : []
    const ok = one.filter((n) => assetSet.has(n))
    if (ok.length) p.phase[k] = ok
  }
  // 工作状态素材不参与待机/趣味的随机池，不然待机时会撞出「工作中」的动作
  const phaseAnims = new Set()
  for (const k of Object.keys(p.phase)) for (const n of p.phase[k]) phaseAnims.add(n)

  const idleSet = new Set(cfg.idleAnims || [])

  for (const a of assets) {
    if (phaseAnims.has(a)) {
      /* 已在 p.phase 里按配置归好类了 */
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

  const phaseItems = []
  for (const k of Object.keys(pools.phase)) {
    for (const n of pools.phase[k]) {
      // 同一档有多段时把档位名带上，菜单里才分得清「工作中：忙碌点按」和「工作中：写代码」
      const label =
        pools.phase[k].length > 1
          ? `${phaseLabels[n] || cfg.phases[k].label || k}：${n}`
          : phaseLabels[n] || k
      phaseItems.push({ name: n, label })
    }
  }
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
