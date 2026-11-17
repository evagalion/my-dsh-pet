'use strict'

// 桌面巡游纯函数：沿屏幕底边走 → 偶尔沿边缘爬到顶部菜单栏倒挂 → 再爬下来。
// 鼠标靠近会短暂加速躲开。
//
// 这里只算「下一帧坐标」，不动窗口。主进程持有 state 并按帧调 win.setPosition，
// 跟现有的飞行/走路一个套路。做成纯函数是为了自检能直接断言转身/爬升/躲鼠标。
//
// 免系统授权：只用 Electron 自己的窗口坐标 + screen.getCursorScreenPoint()，
// 不读别的窗口标题栏，也不需要辅助功能权限。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const rand = (a, b) => a + Math.random() * (b - a)

// 关键：用「固定步长」而不是「速度 × dt」。
// dt 会随定时器抖动（视频解码/GC 卡一下 dt 就变大），乘出来那一帧鱼突然蹦十几像素，
// 下一帧又只走两三像素 —— 肉眼看到的就是「平移掉帧/一顿一顿」。
// 固定步长让每帧位移恒定，帧率再抖也只是走得慢一点，绝不会跳步。
const STEP = 2 // 水平巡游：每 tick 位移 px
const CLIMB_STEP = 4 // 沿边缘爬：每 tick 位移 px
const DODGE_STEP = 5 // 躲鼠标：每 tick 位移 px
const Y_EASE = 0.25 // 高度向目标靠拢的比例（平滑贴底/贴顶）
const DODGE_RADIUS = 150 // 鼠标进入这个半径（按窗口中心算）就躲
const DODGE_MS = 900 // 一次躲避持续多久
const EDGE_PAUSE_MS = 550 // 到屏幕边缘停一下再转身

// mode: floor（底边走）| ceiling（顶部倒挂走）| climb（沿边缘爬）
function create(x, y, mode, now, dir) {
  const from = mode === 'ceiling' ? 'ceiling' : 'floor'
  return {
    x,
    y,
    mode: from,
    dir: dir == null ? (Math.random() < 0.5 ? 1 : -1) : dir < 0 ? -1 : 1,
    edge: null,
    targetY: null,
    inverted: from === 'ceiling',
    // 先走一会儿再换边，别刚开就往上爬
    modeUntil: now + rand(32000, 58000),
    dodgeUntil: 0,
    pauseUntil: 0,
  }
}

function center(s, b) {
  return { x: s.x + ((b && b.w) || 160) / 2, y: s.y + ((b && b.h) || 140) / 2 }
}

// 推进一帧。dt 只为兼容旧调用签名保留，位移一律用固定步长。
// bounds: { x, y, width, height, floorY, ceilY, w, h }
// mouse: screen.getCursorScreenPoint() 的 {x, y}，可为 null。
function step(s, dt, bounds, mouse, now) {
  if (!s || !bounds) return s
  if (s.pauseUntil > now) return s

  // 鼠标靠近：朝远离它的方向转身，并进入一小段加速
  const c = center(s, bounds)
  if (mouse && Number.isFinite(mouse.x) && Number.isFinite(mouse.y)) {
    const dx = c.x - mouse.x
    const dy = c.y - mouse.y
    if (dx * dx + dy * dy < DODGE_RADIUS * DODGE_RADIUS && s.dodgeUntil <= now) {
      s.dir = dx >= 0 ? 1 : -1
      s.dodgeUntil = now + DODGE_MS
    }
  }
  const stepX = s.dodgeUntil > now ? DODGE_STEP : STEP

  if (s.mode === 'climb') {
    s.x = s.edge === 'left' ? bounds.x : bounds.x + bounds.width
    const dy = s.targetY - s.y
    const move = Math.sign(dy) * CLIMB_STEP
    s.y = Math.abs(move) >= Math.abs(dy) ? s.targetY : s.y + move
    s.y = clamp(s.y, bounds.y, bounds.y + bounds.height)
    // 爬到位 → 切换成顶/底巡游，倒挂标记随模式走
    if (s.y === s.targetY) {
      s.mode = s.targetY <= bounds.ceilY ? 'ceiling' : 'floor'
      s.inverted = s.mode === 'ceiling'
      s.modeUntil = now + rand(26000, 48000)
      s.pauseUntil = now + 350
      s.targetY = null
    }
    return s
  }

  // 水平巡游：平滑靠拢当前模式的高度（底边 / 顶部），再按固定步长左右走
  const goalY = s.mode === 'floor' ? bounds.floorY : bounds.ceilY
  s.y += (goalY - s.y) * Y_EASE
  s.x += s.dir * stepX

  const minX = bounds.x
  const maxX = bounds.x + bounds.width
  if (s.x <= minX) {
    s.x = minX
    s.dir = 1
    s.pauseUntil = now + EDGE_PAUSE_MS
  } else if (s.x >= maxX) {
    s.x = maxX
    s.dir = -1
    s.pauseUntil = now + EDGE_PAUSE_MS
  }

  // 时间到 → 选离自己近的那条边爬过去
  if (now >= s.modeUntil) {
    const from = s.mode
    s.edge = s.x - minX < (maxX - minX) / 2 ? 'left' : 'right'
    s.targetY = from === 'floor' ? bounds.ceilY : bounds.floorY
    s.mode = 'climb'
    s.pauseUntil = now + 250
  }
  return s
}

module.exports = { create, step, center, STEP, DODGE_RADIUS }
