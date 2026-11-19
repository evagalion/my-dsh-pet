'use strict'

// 纯函数物理：抛掷飞行、地面摩擦、边缘反弹。
// 主进程持有状态并按帧推进窗口位置，渲染进程只负责播动画。

const GRAVITY = 2600        // px/s²
const RESTITUTION = 0.42    // 触地/撞墙能量保留
const FLOOR_FRICTION = 0.86 // 触地水平衰减
const CEIL_BOUNCE = 0.5
const STOP_VY = 70          // 低于此竖直速度视为落地
const STOP_VX = 30          // 低于此水平速度视为停稳

function createFlight(x, y, vx, vy) {
  return { x, y, vx, vy, flying: true, landed: false }
}

// 推进一帧。bounds 为可移动区域（已扣除宠物尺寸）。
// opts.ceiling === false 时不拦上沿：弹弓模式要像愤怒小鸟那样，
// 允许鱼飞出屏幕上沿沿完整抛物线命中右侧罐塔，而不是被顶边弹回来。
function step(s, dt, bounds, opts) {
  if (!s.flying) return s

  s.vy += GRAVITY * dt
  s.x += s.vx * dt
  s.y += s.vy * dt

  const minX = bounds.x
  const maxX = bounds.x + bounds.width
  const minY = bounds.y
  const maxY = bounds.y + bounds.height

  if (s.y >= maxY) {
    s.y = maxY
    if (Math.abs(s.vy) > STOP_VY) {
      s.vy = -Math.abs(s.vy) * RESTITUTION
      s.vx *= FLOOR_FRICTION
    } else {
      s.vy = 0
      s.vx *= 0.6
      s.landed = true
      if (Math.abs(s.vx) < STOP_VX) {
        s.vx = 0
        s.flying = false
      }
    }
  }

  const ceilingOn = !opts || opts.ceiling !== false
  if (ceilingOn && s.y <= minY) {
    s.y = minY
    s.vy = Math.abs(s.vy) * CEIL_BOUNCE
  }

  if (s.x <= minX) {
    s.x = minX
    s.vx = Math.abs(s.vx) * RESTITUTION
  }
  if (s.x >= maxX) {
    s.x = maxX
    s.vx = -Math.abs(s.vx) * RESTITUTION
  }

  return s
}

module.exports = { createFlight, step, GRAVITY }
