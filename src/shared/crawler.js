'use strict'

// 桌面巡游「行为状态机」：让鱼像活物一样走走停停，而不是匀速直线当贴纸滑。
//
// 两层状态：
//   place    —— 在哪里：floor（底边）/ ceiling（顶部倒挂）/ climb（正沿边缘爬）
//   activity —— 在干嘛：walk 漫步 / run 小跑 / look 驻足张望 / stretch 伸懒腰 / shy 害羞 / greet 打招呼 / flee 溜走
//
// 关键改动（相对第一版匀速直线）：
//  1. 速度不再是常数：vx 缓动逼近目标速度（漫步慢、小跑快、驻足为 0），起步/停下自然过渡。
//  2. 会主动换行为：漫步一段就停下张望/伸懒腰，偶尔小跑一段。行为由「行为议程」驱动，
//     每项有持续时长，到期换下一项。渲染层据此播不同动画+台词。
//  3. 鼠标靠近给多种俏皮反应（害羞 / 打招呼 / 溜走）随机挑，不再是单向逃。
//
// 纯函数：这里只算「下一帧坐标 + 当前行为」，不动窗口。主进程持有 state 按帧调 setPosition。
// 只用窗口坐标 + 全局鼠标位置，不读别的窗口，不需要系统授权。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const rand = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 各行为的移动速度（px/tick）。驻足类为 0，鱼会停下来播动画。
const SPEED = {
  walk: 1.6, // 漫步
  run: 4.2, // 小跑
  look: 0, // 驻足张望
  stretch: 0, // 伸懒腰
  shy: 0, // 害羞停住
  greet: 0, // 打招呼停住
  flee: 5.5, // 溜走
  climb: 2.6, // 沿边缘爬
}
// 加速度：vx 每帧向目标逼近这个比例，越小越平滑（起步/刹车不会瞬移）
const EASE = 0.18
const DODGE_RADIUS = 170 // 鼠标进入这个半径（按窗口中心算）触发互动
const REACT_COOLDOWN = 4200 // 两次鼠标互动的最小间隔 ms
const EDGE_PAUSE_MS = 600 // 到屏幕边缘转身前的停顿
const BEHAVIOR_MIN = 2600 // 一个行为最短持续
const BEHAVIOR_MAX = 5600 // 一个行为最长持续
const CLIMB_MS = 6000 // 沿边缘爬的时长上限（防止卡住）
const REACT_MS = 2200 // 害羞/打招呼/溜走这类短反应的持续

// 漫步时可能切换到的「日常行为」及其权重（张望/伸懒腰多，小跑少）
const IDLE_BEHAVIORS = [
  ['walk', 5],
  ['run', 2],
  ['look', 3],
  ['stretch', 2],
]
function weightedBehavior() {
  let total = 0
  for (const [, w] of IDLE_BEHAVIORS) total += w
  let r = Math.random() * total
  for (const [k, w] of IDLE_BEHAVIORS) {
    if ((r -= w) <= 0) return k
  }
  return 'walk'
}

// place: floor | ceiling | climb
function create(x, y, place, now, dir) {
  const p = place === 'ceiling' ? 'ceiling' : 'floor'
  return {
    x,
    y,
    place: p,
    activity: 'walk', // 当前行为
    dir: dir == null ? (Math.random() < 0.5 ? 1 : -1) : dir < 0 ? -1 : 1,
    vx: 0, // 当前水平速度（缓动用）
    edge: null,
    targetY: null,
    inverted: p === 'ceiling',
    behaviorUntil: now + rand(BEHAVIOR_MIN, BEHAVIOR_MAX), // 下次换日常行为
    placeUntil: now + rand(34000, 60000), // 下次换位置（爬到顶/底）
    reactUntil: 0, // 鼠标互动冷却结束时刻
    actUntil: 0, // 当前短反应（害羞等）结束时刻，0 表示无
    pauseUntil: 0,
    climbDeadline: 0,
  }
}

function center(s, b) {
  return { x: s.x + ((b && b.w) || 160) / 2, y: s.y + ((b && b.h) || 140) / 2 }
}

// 切换到一次短反应：shy / greet / flee。
function react(s, kind, now) {
  s.activity = kind
  s.actUntil = now + REACT_MS
  s.reactUntil = now + REACT_COOLDOWN
  return true
}

// 结束短反应，回到日常漫步
function endReact(s, now) {
  s.activity = 'walk'
  s.actUntil = 0
  s.behaviorUntil = now + rand(BEHAVIOR_MIN, BEHAVIOR_MAX)
}

// 推进一帧。dt 保留兼容签名但位移用固定步长（防定时器抖动跳步）。
// bounds: { x, y, width, height, floorY, ceilY, w, h }
// mouse: {x, y} 可为 null。返回 { changed: bool } 表示行为是否变化（主进程据此推动画台词）。
function step(s, dt, bounds, mouse, now) {
  if (!s || !bounds) return { changed: false }
  let changed = false

  if (s.pauseUntil > now) return { changed: false }

  // 正在沿边缘爬
  if (s.place === 'climb') {
    if (s.activity !== 'climb') {
      s.activity = 'climb'
      changed = true
    }
    s.x = s.edge === 'left' ? bounds.x : bounds.x + bounds.width
    const dy = s.targetY - s.y
    const move = Math.sign(dy) * SPEED.climb
    s.y = Math.abs(move) >= Math.abs(dy) ? s.targetY : s.y + move
    s.y = clamp(s.y, bounds.y, bounds.y + bounds.height)
    const arrived = s.y === s.targetY
    const timedOut = now >= s.climbDeadline
    if (arrived || timedOut) {
      s.place = s.targetY <= bounds.ceilY ? 'ceiling' : 'floor'
      s.inverted = s.place === 'ceiling'
      s.activity = 'walk'
      s.behaviorUntil = now + rand(BEHAVIOR_MIN, BEHAVIOR_MAX)
      s.placeUntil = now + rand(34000, 60000)
      s.targetY = null
      s.vx = 0
      s.pauseUntil = now + 300
      changed = true
    }
    return { changed }
  }

  // ---- 在 floor / ceiling 巡游 ----

  // 鼠标互动：靠近了随机给个俏皮反应，不再只躲
  if (mouse && Number.isFinite(mouse.x) && Number.isFinite(mouse.y) && now >= s.reactUntil) {
    const c = center(s, bounds)
    const dx = c.x - mouse.x
    const dy = c.y - mouse.y
    if (dx * dx + dy * dy < DODGE_RADIUS * DODGE_RADIUS) {
      const kind = pick(['shy', 'greet', 'flee'])
      // 溜走要背对鼠标；打招呼/害羞则面向鼠标
      s.dir = kind === 'flee' ? dx >= 0 ? 1 : -1 : dx >= 0 ? -1 : 1
      react(s, kind, now)
      changed = true
    }
  }

  // 短反应到期 → 回漫步
  if (s.actUntil && now >= s.actUntil) {
    endReact(s, now)
    changed = true
  } else if (!s.actUntil && now >= s.behaviorUntil) {
    // 日常行为到期 → 换一个
    const next = weightedBehavior()
    if (next !== s.activity) {
      s.activity = next
      changed = true
    }
    s.behaviorUntil = now + rand(BEHAVIOR_MIN, BEHAVIOR_MAX)
  }

  // 速度缓动逼近目标：起步/刹车自然，不是瞬间变速
  const target = SPEED[s.activity] || 0
  s.vx += (target - s.vx) * EASE
  if (Math.abs(s.vx) < 0.05) s.vx = 0
  s.x += s.dir * s.vx

  // 高度平滑靠拢当前位置（底边 / 顶部）
  const goalY = s.place === 'floor' ? bounds.floorY : bounds.ceilY
  s.y += (goalY - s.y) * 0.25

  const minX = bounds.x
  const maxX = bounds.x + bounds.width
  if (s.x <= minX) {
    s.x = minX
    s.dir = 1
    s.vx = 0
    s.pauseUntil = now + EDGE_PAUSE_MS
  } else if (s.x >= maxX) {
    s.x = maxX
    s.dir = -1
    s.vx = 0
    s.pauseUntil = now + EDGE_PAUSE_MS
  }

  // 位置到期 → 选近的一边爬去另一端
  if (now >= s.placeUntil) {
    s.edge = s.x - minX < (maxX - minX) / 2 ? 'left' : 'right'
    s.targetY = s.place === 'floor' ? bounds.ceilY : bounds.floorY
    s.place = 'climb'
    s.climbDeadline = now + CLIMB_MS
    s.pauseUntil = now + 250
    changed = true
  }

  return { changed }
}

module.exports = {
  create,
  step,
  center,
  react,
  SPEED,
  DODGE_RADIUS,
  REACT_COOLDOWN,
}
