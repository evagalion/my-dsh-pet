'use strict'

// 弹弓「真发射器」模式：弹射的就是桌面上这只真桌宠窗口本身。
// 不做画布里的小游戏——复用主进程已有的 api.throw → startFlight 物理：
// 拖拽时鱼在窗口内被拉后、皮筋拉伸、瞄准线出现；松手调 api.throw 把整个窗口弹飞，
// 撞墙反弹、落地动画都由主进程 physics.js 管。落地后弹弓在新位置重新架好。
// 自包含模块，挂到 window.SlingshotGame。
;(function () {
  const GRAVITY = 2600 // 与主进程 physics.js 保持一致（瞄准线用）
  const POWER = 21 // 拉伸像素 → 初速度 px/s（加大，够打到上方罐子）
  const MAX_PULL = 84 // 皮筋最大拉伸（四向都能拉满）
  const MIN_PULL = 16 // 小于此视为没拉
  // 弹射方向是拉伸的反方向：往下拉→向上弹。所以必须允许往下拉足够多，
  // 否则只能往下弹。鱼贴底，下拉时脚会略微沉出窗口底，可以接受。
  const PULL_DOWN_CAP = 84

  let open = false
  let flying = false
  let root = null // HUD 容器（canvas + 提示条）
  let canvas = null
  let ctx = null
  let raf = 0
  let levelInfo = { level: 1, name: '', ammo: 0, score: 0 }
  let start = null // 拖拽起点（clientX/clientY）
  let pull = { x: 0, y: 0 }
  let dpr = 1
  let vw = 320
  let vh = 280

  // 鱼在窗口里的静止中心（贴底、水平居中）——皮兜默认位置
  function restPoint() {
    return { x: vw / 2, y: vh - 44 }
  }
  // 弹道起算点：鱼身中心（与主进程命中判定 flight.y + h*0.68 一致）。
  // 这样全屏弹道画的就是"鱼身中心真实的飞行轨迹"，与命中判定完全吻合。
  function bodyPoint() {
    return { x: vw / 2, y: vh * 0.68 }
  }
  function forkTips() {
    const c = restPoint()
    return [
      { x: c.x - 18, y: c.y - 16 },
      { x: c.x + 18, y: c.y - 16 },
    ]
  }
  // 鱼本体/皮兜只跟移一小段做视觉反馈，避免真拖 84px 时整条鱼沉出窗口底看不见；
  // 弹射力度与瞄准方向仍用完整的 pull 计算。
  const VISUAL_SCALE = 0.4
  function pouchPoint() {
    const c = restPoint()
    return { x: c.x + pull.x * VISUAL_SCALE, y: c.y + pull.y * VISUAL_SCALE }
  }

  function clampPull(x, y) {
    // 往下受限（鱼贴底会被裁），左右/往上给足
    if (y > PULL_DOWN_CAP) y = PULL_DOWN_CAP
    const d = Math.hypot(x, y)
    if (d > MAX_PULL) {
      x = (x / d) * MAX_PULL
      y = (y / d) * MAX_PULL
    }
    return { x, y }
  }

  // ---- 全屏瞄准弹道 ----
  // HUD Canvas 只有桌宠窗口那么大（320×280），弹道一飞出窗口就被裁掉，
  // 所以只画窗口内那一小段（用户看到的"两个点"）。真正的完整抛物线交给
  // 全屏目标层画：这里算出相对窗口的弹道点，主进程换成屏幕坐标再转发。
  const AIM_STEPS = 100 // 物理步进帧数（60fps，约 1.67s，足够打到右侧罐塔）
  const AIM_DOT_EVERY = 3 // 每隔几步取一个点
  function computeTrajectory(vx, vy) {
    const p = bodyPoint()
    let x = p.x
    let y = p.y
    let curVy = vy
    const pts = []
    for (let i = 0; i < AIM_STEPS; i++) {
      curVy += GRAVITY / 60
      x += vx / 60
      y += curVy / 60
      if (i % AIM_DOT_EVERY === 0) pts.push({ x, y })
      if (y > vh + 1600) break // 早就飞出屏幕了，没必要再算
    }
    return pts
  }
  function publishAim() {
    if (!window.petAPI || !window.petAPI.sgAim) return
    const d = Math.hypot(pull.x, pull.y)
    if (d < MIN_PULL) {
      clearAim()
      return
    }
    const pts = computeTrajectory(-pull.x * POWER, -pull.y * POWER)
    window.petAPI.sgAim(pts)
  }
  function clearAim() {
    if (window.petAPI && window.petAPI.sgAimClear) window.petAPI.sgAimClear()
  }

  // ---- 音效（Web Audio 合成，无素材依赖）----
  let actx = null
  function beep(freq, dur, type, vol, slideTo) {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)()
      const o = actx.createOscillator()
      const g = actx.createGain()
      o.type = type || 'sine'
      o.frequency.setValueAtTime(freq, actx.currentTime)
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(60, slideTo), actx.currentTime + dur)
      g.gain.setValueAtTime(vol || 0.12, actx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur)
      o.connect(g)
      g.connect(actx.destination)
      o.start()
      o.stop(actx.currentTime + dur)
    } catch (e) {
      /* 静音 */
    }
  }
  function sfxStretch() { beep(360, 0.07, 'sine', 0.04, 300) }
  function sfxLaunch() { beep(280, 0.18, 'triangle', 0.16, 620); setTimeout(() => beep(820, 0.1, 'sine', 0.1), 70) }
  function sfxLand() { beep(180, 0.16, 'sine', 0.12, 90) }
  function sfxTargetHit() {
    beep(680, 0.09, 'square', 0.1, 980)
    setTimeout(() => beep(1150, 0.12, 'sine', 0.09, 1400), 55)
  }
  function sfxClear() {
    ;[660, 880, 1046, 1320].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'sine', 0.1), i * 110))
  }

  function mount() {
    if (root) return
    vw = window.innerWidth
    vh = window.innerHeight
    dpr = Math.min(2, window.devicePixelRatio || 1)

    root = document.createElement('div')
    root.id = 'slingshot-hud'
    root.innerHTML =
      '<canvas id="sg-canvas"></canvas>' +
      '<div class="sg-hint" id="sg-hint"><span class="sg-hint-text">🎯 弹弓模式 · 按住往后拉，松手弹飞</span>' +
      '<button class="sg-exit" id="sg-exit" type="button">结束 ✕</button></div>' +
      '<div class="sg-count" id="sg-count"></div>'
    document.body.appendChild(root)
    canvas = document.getElementById('sg-canvas')
    ctx = canvas.getContext('2d')
    resize()
    document.getElementById('sg-exit').addEventListener('click', (e) => {
      e.stopPropagation()
      close()
    })
    window.addEventListener('resize', resize)
  }

  function resize() {
    if (!canvas) return
    vw = window.innerWidth
    vh = window.innerHeight
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(vw * dpr)
    canvas.height = Math.round(vh * dpr)
    canvas.style.width = vw + 'px'
    canvas.style.height = vh + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // ---- 拖拽蓄力：由 app.js 在弹弓模式下转发 pointer 事件 ----
  function beginDrag(e) {
    if (!open || flying) return
    start = { x: e.clientX, y: e.clientY }
    pull = { x: 0, y: 0 }
    applyFishOffset()
    clearAim()
    draw()
  }
  function moveDrag(e) {
    if (!open || flying || !start) return
    const raw = clampPull(e.clientX - start.x, e.clientY - start.y)
    const changed = Math.hypot(raw.x - pull.x, raw.y - pull.y) > 6
    pull = raw
    applyFishOffset()
    publishAim() // 完整弹道发到全屏目标层
    draw()
    if (changed) sfxStretch()
  }
  function releaseDrag() {
    if (!open || flying || !start) return null
    start = null
    clearAim() // 松手就收起瞄准弹道
    const d = Math.hypot(pull.x, pull.y)
    if (d < MIN_PULL) {
      pull = { x: 0, y: 0 }
      applyFishOffset()
      draw()
      return null
    }
    // 初速度与拉伸方向相反：往左下拉 → 往右上飞
    const vx = -pull.x * POWER
    const vy = -pull.y * POWER
    pull = { x: 0, y: 0 }
    applyFishOffset()
    flying = true
    document.body.classList.add('slingshot-flying')
    setHint('🚀 飞出去啦！')
    sfxLaunch()
    draw() // 飞行态：清掉弹弓视觉
    return { vx, vy }
  }

  // 鱼本体跟着拉伸在窗口内位移（transform 打在 #stage 上）
  function applyFishOffset() {
    const stage = document.getElementById('stage')
    if (!stage) return
    stage.style.transform = 'translate(' + (pull.x * VISUAL_SCALE).toFixed(1) + 'px,' + (pull.y * VISUAL_SCALE).toFixed(1) + 'px)'
  }
  function resetFishOffset() {
    const stage = document.getElementById('stage')
    if (stage) stage.style.transform = ''
  }

  function onLanded() {
    if (!open) return
    flying = false
    document.body.classList.remove('slingshot-flying')
    pull = { x: 0, y: 0 }
    resetFishOffset()
    clearAim()
    setHint('🎯 落地啦 · 再拉一次弹飞我')
    sfxLand()
    draw()
  }

  // ---- 绘制 ----
  function draw() {
    if (!ctx) return
    ctx.clearRect(0, 0, vw, vh)
    if (!open || flying) return // 飞行时窗口在飞，弹弓视觉收起
    const c = restPoint()
    const tips = forkTips()
    // 地面小阴影
    ctx.fillStyle = 'rgba(90,70,50,0.13)'
    ctx.beginPath()
    ctx.ellipse(c.x, vh - 6, 34, 7, 0, 0, Math.PI * 2)
    ctx.fill()
    // 弹弓木叉
    ctx.strokeStyle = '#8b5a2b'
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(c.x, vh - 4)
    ctx.lineTo(c.x, c.y - 8)
    ctx.stroke()
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(c.x, c.y - 10)
    ctx.lineTo(tips[0].x, tips[0].y - 8)
    ctx.moveTo(c.x, c.y - 10)
    ctx.lineTo(tips[1].x, tips[1].y - 8)
    ctx.stroke()
    // 叉尖包边
    ctx.fillStyle = '#6f4520'
    for (const t of tips) {
      ctx.beginPath()
      ctx.arc(t.x, t.y - 8, 4, 0, Math.PI * 2)
      ctx.fill()
    }

    const pouch = pouchPoint()
    // 皮筋（叉尖 → 皮兜）
    ctx.strokeStyle = '#5a3820'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(tips[0].x, tips[0].y - 8)
    ctx.lineTo(pouch.x - 8, pouch.y)
    ctx.moveTo(tips[1].x, tips[1].y - 8)
    ctx.lineTo(pouch.x + 8, pouch.y)
    ctx.stroke()
    // 皮兜
    ctx.fillStyle = '#4a2f1a'
    roundRect(pouch.x - 10, pouch.y - 5, 20, 10, 4)
    ctx.fill()

    // 瞄准弹道已交给全屏目标层绘制（见 publishAim / targets.js），
    // 因为本 Canvas 只有桌宠窗口大小，画到窗口外会被裁成"两个点"。
    // 这里只保留窗口内的力度条。
    const d = Math.hypot(pull.x, pull.y)
    if (d >= MIN_PULL) {
      // 力度条（放在提示条下方，别被挡住）
      const ratio = Math.min(1, d / MAX_PULL)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      roundRect(c.x - 40, 42, 80, 8, 4)
      ctx.fill()
      ctx.fillStyle = ratio > 0.8 ? '#e0679a' : ratio > 0.5 ? '#f2a93b' : '#4c9e6a'
      roundRect(c.x - 40, 42, 80 * ratio, 8, 4)
      ctx.fill()
    }
    raf = requestAnimationFrame(draw)
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  function setHint(text) {
    const el = document.getElementById('sg-hint-text')
    if (el) el.textContent = text
  }
  function updateCount() {
    const el = document.getElementById('sg-count')
    if (!el) return
    el.textContent = '第 ' + levelInfo.level + ' 关 · ' + levelInfo.name + ' · 弹药 ' + levelInfo.ammo
    el.classList.toggle('low', levelInfo.ammo <= 1)
  }

  // ---- 对外 API ----
  function enter() {
    mount()
    open = true
    flying = false
    levelInfo = { level: 1, name: '', ammo: 0, score: 0 }
    start = null
    pull = { x: 0, y: 0 }
    root.classList.add('show')
    document.body.classList.add('slingshot-mode')
    resetFishOffset()
    setHint('🎯 弹弓模式 · 按住往后拉，松手弹飞')
    updateCount()
    sfxLaunch()
    cancelAnimationFrame(raf)
    draw()
  }
  function close() {
    if (!open) return
    open = false
    flying = false
    cancelAnimationFrame(raf)
    raf = 0
    if (root) root.classList.remove('show')
    document.body.classList.remove('slingshot-mode')
    document.body.classList.remove('slingshot-flying')
    resetFishOffset()
    clearAim()
    start = null
    pull = { x: 0, y: 0 }
    // 通知主进程复位模式标志，菜单下次点击才能正确 toggle
    if (window.petAPI && window.petAPI.gameClose) window.petAPI.gameClose()
  }
  function isOpen() { return open }
  function isFlying() { return flying }

  // 命中目标 / 全清：由 app.js 收到主进程消息后转发
  function onTargetHit() {
    if (!open) return
    sfxTargetHit()
    setHint('💥 命中！继续弹我')
  }
  function onClear() {
    if (!open) return
    sfxClear()
    setHint('🎉 全部击倒！太厉害啦')
  }
  // 主进程同步关卡状态（进关 / 每次发射后弹药变化）
  function onLevel(d) {
    if (!open || !d) return
    levelInfo = {
      level: d.level || 1,
      name: d.name || '',
      ammo: d.ammo == null ? 0 : d.ammo,
      score: d.score || 0,
    }
    updateCount()
  }
  function onFail() {
    if (!open) return
    setHint('💥 弹药耗尽 · 本关重来')
  }
  function onRespawn() {
    if (!open) return
    setHint('🎯 新一关来啦 · 继续弹我')
  }

  // 自检：纯逻辑，不依赖真实浏览器
  function probeLogic() {
    const c = clampPull(-200, 200)
    const clampOk = Math.abs(Math.hypot(c.x, c.y) - MAX_PULL) < 0.5 && c.y <= PULL_DOWN_CAP + 0.01
    const vx = -c.x * POWER
    const vy = -c.y * POWER
    const dirOk = vx > 0 && vy < 0 // 往左下蓄力 → 往右上飞
    // 抛物线：初速向上，受重力后必定回落
    let y = 0
    let vy2 = -600
    let minY = 0
    for (let i = 0; i < 60; i++) {
      vy2 += GRAVITY / 60
      y += vy2 / 60
      minY = Math.min(minY, y)
    }
    const arcOk = minY < 0 && y > minY
    // 全屏弹道：点数足够多、横向确实打向右边（不再只画窗口内两个点）
    const traj = computeTrajectory(-c.x * POWER, -c.y * POWER)
    const trajOk = traj.length >= 20 && traj[traj.length - 1].x > traj[0].x + 200
    const setupOk = MAX_PULL > MIN_PULL && POWER > 0 && GRAVITY > 0
    // 关卡 HUD 回调就位（关卡/失败/重来）
    const levelHudOk = typeof onLevel === 'function' && typeof onFail === 'function' && typeof onRespawn === 'function'
    return { clampOk, dirOk, arcOk, trajOk, trajDots: traj.length, setupOk, levelHudOk, maxPull: MAX_PULL, power: POWER }
  }

  window.SlingshotGame = {
    enter,
    close,
    isOpen,
    isFlying,
    beginDrag,
    moveDrag,
    releaseDrag,
    onLanded,
    onTargetHit,
    onClear,
    onLevel,
    onFail,
    onRespawn,
    probeLogic,
  }
})()
