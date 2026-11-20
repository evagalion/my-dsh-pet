'use strict'

// 目标层渲染：主进程把目标（相对本窗口坐标）+ 分数 + 命中特效发来，这里只负责画。
// 鼠标完全穿透，命中判定在主进程（鱼窗口中心 vs 目标屏幕坐标）。
;(function () {
  const api = window.targetAPI
  const canvas = document.getElementById('t-canvas')
  const ctx = canvas.getContext('2d')
  const scoreEl = document.getElementById('t-score')
  const levelEl = document.getElementById('t-level')
  const ammoEl = document.getElementById('t-ammo')
  const bannerEl = document.getElementById('t-banner')
  let dpr = 1
  let targets = []
  let effects = [] // 撞击特效：碎片 / 冲击波 / 火花 / 飘字
  let aimPoints = [] // 全屏瞄准弹道（相对本窗口坐标）
  let raf = 0
  let shake = 0 // 屏幕震动强度（撞击感核心），每帧衰减

  function resize(w, h) {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function frame() {
    const W = canvas.width / dpr, H = canvas.height / dpr
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    // 屏幕震动：撞击瞬间整屏抖一下（撞击感的灵魂）。随机方向 + 快速衰减。
    if (shake > 0.15) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake)
      shake *= 0.82 // 每帧衰减，约 8 帧归零
    } else {
      shake = 0
    }
    for (const t of targets) {
      if (t.alive) drawCan(t.x, t.y, t.r, t.pts, t.hitFlash || 0, t.maxHp > 1, t.hp < t.maxHp)
    }
    // 全屏瞄准弹道：从近到远的粉色圆点，越远越小越淡，完整可见
    if (aimPoints.length) {
      const n = aimPoints.length
      for (let i = 0; i < n; i++) {
        const p = aimPoints[i]
        const k = n > 1 ? i / (n - 1) : 0 // 0→1，越远越淡
        ctx.globalAlpha = 0.9 - k * 0.58
        ctx.fillStyle = i % 5 === 0 ? '#ff3d86' : '#ff8fc0'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 4.4 - k * 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    // ---- 撞击特效绘制 ----
    for (const e of effects) {
      const age = 1 - e.life / e.max // 0→1 生命周期进度
      if (e.kind === 'shard') {
        // 罐子碎片：带旋转的不规则多边形，像被砸碎的陶瓷/铁皮
        ctx.save()
        ctx.globalAlpha = Math.max(0, 1 - age * age)
        ctx.translate(e.x, e.y)
        ctx.rotate(e.rot)
        ctx.fillStyle = e.color
        ctx.beginPath()
        ctx.moveTo(-e.size, -e.size * 0.6)
        ctx.lineTo(e.size * 0.7, -e.size)
        ctx.lineTo(e.size, e.size * 0.5)
        ctx.lineTo(-e.size * 0.5, e.size * 0.9)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      } else if (e.kind === 'ring') {
        // 冲击波：撞击点扩散的圆环，快速变大变淡
        ctx.globalAlpha = Math.max(0, 1 - age) * 0.85
        ctx.strokeStyle = e.color
        ctx.lineWidth = Math.max(1, 6 * (1 - age))
        ctx.beginPath()
        ctx.arc(e.x, e.y, 6 + age * e.radius, 0, Math.PI * 2)
        ctx.stroke()
      } else if (e.kind === 'flash') {
        // 闪光：撞击瞬间的高亮白点，急速收缩消失
        ctx.globalAlpha = Math.max(0, 1 - age) * 0.9
        const rr = e.size * (1 - age * 0.5)
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rr)
        g.addColorStop(0, 'rgba(255,255,255,1)')
        g.addColorStop(0.35, e.color)
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(e.x, e.y, rr, 0, Math.PI * 2)
        ctx.fill()
      } else if (e.kind === 'spark') {
        // 火花：细长的快速亮点，带拖尾
        ctx.globalAlpha = Math.max(0, 1 - age)
        ctx.strokeStyle = e.color
        ctx.lineWidth = e.size
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(e.x, e.y)
        ctx.lineTo(e.x - e.vx * 0.012, e.y - e.vy * 0.012)
        ctx.stroke()
      } else if (e.kind === 'float') {
        // 飘分：弹出时先放大再回弹，带描边更醒目
        const pop = age < 0.22 ? 0.5 + (age / 0.22) * 0.7 : 1.2 - ((age - 0.22) / 0.78) * 0.2
        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, e.life * 1.6))
        ctx.translate(e.x, e.y)
        ctx.scale(pop, pop)
        ctx.font = '800 22px -apple-system, "PingFang SC", sans-serif'
        ctx.textAlign = 'center'
        ctx.lineWidth = 4
        ctx.strokeStyle = 'rgba(40,20,30,0.55)'
        ctx.strokeText(e.text, 0, 0)
        ctx.fillStyle = '#fff'
        ctx.fillText(e.text, 0, 0)
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1
    ctx.restore() // 结束屏幕震动位移
    // ---- 推进物理 ----
    for (const e of effects) {
      e.life -= 1 / 60
      if (e.kind === 'shard') {
        e.x += e.vx / 60
        e.y += e.vy / 60
        e.vy += 1100 / 60 // 重力
        e.vx *= 0.985
        e.rot += e.vrot / 60
      } else if (e.kind === 'spark') {
        e.x += e.vx / 60
        e.y += e.vy / 60
        e.vy += 500 / 60
      } else if (e.kind === 'float') {
        e.y -= 46 / 60
      }
      // ring / flash 不自移动
    }
    effects = effects.filter((e) => e.life > 0)
    // 命中闪光衰减
    for (const t of targets) if (t.hitFlash > 0) t.hitFlash -= 1 / 60
    raf = requestAnimationFrame(frame)
  }

  const COLORS = ['#e0679a', '#378add', '#f2a93b', '#7b6cd4', '#4c9e6a']
  // armored=装甲罐(hp 曾为 2)：金属灰 + 铆钉护盾环；cracked=true 表示刚被打掉一层
  function drawCan(x, y, r, pts, flash, armored, cracked) {
    ctx.save()
    ctx.translate(x, y)
    if (flash > 0) ctx.globalAlpha = Math.max(0, flash)
    const color = armored ? (cracked ? '#9aa7b4' : '#6b7787') : COLORS[pts % COLORS.length]
    // 装甲罐外层护盾环
    if (armored && !cracked) {
      ctx.strokeStyle = 'rgba(120,140,160,0.6)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2)
      ctx.stroke()
    }
    // 罐身
    ctx.fillStyle = flash > 0 ? '#fff' : color
    roundRect(-r, -r * 1.1, r * 2, r * 2.2, 6)
    ctx.fill()
    // 罐盖
    ctx.fillStyle = flash > 0 ? '#fff' : 'rgba(0,0,0,0.22)'
    roundRect(-r, -r * 1.1 - 3, r * 2, 6, 3)
    ctx.fill()
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    roundRect(-r * 0.62, -r * 0.8, r * 0.4, r * 1.5, 3)
    ctx.fill()
    // 裂纹：装甲被打掉一层后画一道闪电裂纹
    if (armored && cracked) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(-r * 0.5, -r * 0.7)
      ctx.lineTo(r * 0.1, -r * 0.1)
      ctx.lineTo(-r * 0.3, r * 0.3)
      ctx.lineTo(r * 0.5, r * 0.8)
      ctx.stroke()
    }
    // 分数 / 护盾标识
    ctx.fillStyle = '#fff'
    ctx.font = '700 ' + Math.round(r * 0.8) + 'px -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(armored && !cracked ? '🛡' + pts : String(pts), 0, 2)
    ctx.restore()
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

  api.on('sg:init', (d) => {
    resize(d.width, d.height)
    // 把可点的"结束游戏"按钮放到鱼头顶上方（鱼窗口鼠标穿透后，它 HUD 里的✕点不到）。
    // quitBtn 坐标由主进程按发射台位置算好（相对本窗口），这里只做定位。
    const qb = document.getElementById('t-quit')
    if (qb && d.quitBtn) {
      qb.style.right = 'auto' // 清掉 CSS 兜底的 right，否则 left+right 同时存在会把按钮拉宽
      qb.style.left = d.quitBtn.x + 'px'
      qb.style.top = d.quitBtn.y + 'px'
      qb.style.transform = 'translate(-50%, -100%)'
    }
    // maxHp 是罐子的"原始血量"，只用来判断是否装甲罐/是否已裂；不能用当前 hp 覆盖，
    // 否则装甲罐掉一层血后 maxHp 跟着变 1，护盾环和裂纹状态都会丢失。
    targets = (d.targets || []).map((t) => Object.assign({}, t, { maxHp: t.maxHp || t.hp || 1 }))
    scoreEl.textContent = '得分 ' + (d.score || 0)
    const roundTag = d.cycle > 0 ? ' · 第' + (d.cycle + 1) + '轮' : ''
    const moveTag = d.moving ? ' · 移动靶' : ''
    levelEl.textContent = '第 ' + (d.level || 1) + ' 关 · ' + (d.name || '') + roundTag + moveTag
    setAmmo(d.ammo)
    hideBanner()
    effects = []
    aimPoints = []
    shake = 0
    cancelAnimationFrame(raf)
    frame()
  })

  function setAmmo(n) {
    ammoEl.textContent = '弹药 ' + (n == null ? 0 : n)
    ammoEl.classList.toggle('low', n != null && n <= 1)
  }
  function showBanner(main, sub, fail) {
    bannerEl.innerHTML = main + (sub ? '<span class="t-banner-sub">' + sub + '</span>' : '')
    bannerEl.classList.toggle('fail', !!fail)
    bannerEl.classList.add('show')
  }
  function hideBanner() {
    bannerEl.classList.remove('show')
  }
  api.on('sg:ammo', (d) => setAmmo(d && d.ammo))

  // 移动靶：主进程每帧算好实时屏幕坐标（已转相对本窗口），这里直接更新用于绘制
  api.on('sg:move', (d) => {
    if (!d || !Array.isArray(d.moves)) return
    for (const m of d.moves) {
      const t = targets.find((x) => x.id === m.id)
      if (t) { t.x = m.x; t.y = m.y }
    }
  })

  // 瞄准弹道：主进程已把相对窗口的点换算成相对本目标层的屏幕坐标
  api.on('sg:aim', (d) => {
    aimPoints = d && Array.isArray(d.points) ? d.points : []
  })
  api.on('sg:aim-clear', () => {
    aimPoints = []
  })

  // 撞击特效素材生成器：一体成型的冲击感 = 闪光 + 冲击波 + 碎片 + 火花 + 屏幕震动。
  // dirX/dirY 是鱼撞过来的方向，碎片和火花顺着它喷，像真的被撞飞。
  function addImpactBurst(x, y, color, dirX, dirY, strength) {
    const dx = dirX == null ? 0 : dirX
    const dy = dirY == null ? -1 : dirY
    // 1) 撞击闪光：中心高亮，急速收缩
    effects.push({ kind: 'flash', x, y, color, size: 30 * strength, life: 0.22, max: 0.22 })
    // 2) 冲击波圆环：向外扩散
    effects.push({ kind: 'ring', x, y, color, radius: 52 * strength, life: 0.36, max: 0.36 })
    effects.push({ kind: 'ring', x, y, color: '#ffffff', radius: 34 * strength, life: 0.24, max: 0.24 })
    // 3) 罐子碎片：带旋转的多边形，主方向沿撞击方向喷 + 四散
    const n = Math.round(14 * strength)
    for (let i = 0; i < n; i++) {
      const spread = (Math.random() - 0.5) * 2.4 // 弧度扰动
      const baseAng = Math.atan2(dy, dx) + spread
      const sp = (150 + Math.random() * 340) * strength
      effects.push({
        kind: 'shard', x, y,
        vx: Math.cos(baseAng) * sp,
        vy: Math.sin(baseAng) * sp - 120, // 略微上抛
        size: 3 + Math.random() * 6,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 14,
        color: color,
        life: 0.6 + Math.random() * 0.4, max: 1.0,
      })
    }
    // 4) 火花：细长亮点，顺撞击方向高速溅出
    for (let i = 0; i < 8; i++) {
      const ang = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.6
      const sp = (300 + Math.random() * 420) * strength
      effects.push({
        kind: 'spark', x, y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        size: 1.5 + Math.random() * 2,
        color: i % 2 ? '#fff3c4' : color,
        life: 0.18 + Math.random() * 0.16, max: 0.34,
      })
    }
    // 5) 屏幕震动：撞击感的核心，强度随力量
    shake = Math.max(shake, 13 * strength)
  }

  api.on('sg:hit', (d) => {
    const t = targets.find((x) => x.id === d.id)
    const dirX = d.dirX, dirY = d.dirY
    // 装甲罐掉一层：金属铛的受击——火花 + 小冲击波 + 轻震，不碎、不飘分
    if (d.cracked) {
      if (t) { t.hp = d.hp; t.hitFlash = 1 }
      effects.push({ kind: 'flash', x: d.x, y: d.y, color: '#cfd8e3', size: 22, life: 0.16, max: 0.16 })
      effects.push({ kind: 'ring', x: d.x, y: d.y, color: '#dbe4ee', radius: 36, life: 0.26, max: 0.26 })
      for (let i = 0; i < 7; i++) {
        const ang = Math.atan2(dirY == null ? -1 : dirY, dirX == null ? 0 : dirX) + (Math.random() - 0.5) * 1.8
        const sp = 180 + Math.random() * 280
        effects.push({
          kind: 'spark', x: d.x, y: d.y,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          size: 1.5 + Math.random() * 2, color: i % 2 ? '#fff' : '#b9c6d6',
          life: 0.16 + Math.random() * 0.14, max: 0.3,
        })
      }
      shake = Math.max(shake, 7)
      return
    }
    // 正常击碎：完整撞击特效 + 飘分
    scoreEl.textContent = '得分 ' + d.score
    if (t) { t.alive = false; t.hitFlash = 1 }
    const baseColor = t ? COLORS[t.pts % COLORS.length] : '#e0679a'
    addImpactBurst(d.x, d.y, baseColor, dirX, dirY, 1)
    effects.push({ kind: 'float', x: d.x, y: d.y - 18, text: '+' + d.pts, life: 1.1, max: 1.1 })
  })

  api.on('sg:clear', (d) => {
    scoreEl.textContent = '得分 ' + d.score
    if (d && d.pass !== undefined) {
      if (d.pass) {
        // 每过完一轮（6 关）提示难度升级，让"第二轮变难"清晰可感
        const newRound = d.next > 1 && (d.next - 1) % 6 === 0
        const roundNo = Math.floor((d.next - 1) / 6) + 1
        const sub = newRound
          ? '⚠️ 第 ' + roundNo + ' 轮：目标更小 · 弹药更紧 · 移动靶'
          : '下一关：' + d.next + ' · 得分 ' + d.score
        showBanner('🎉 第 ' + d.level + ' 关通过！', sub, false)
      } else {
        showBanner('💥 弹药耗尽', '第 ' + d.level + ' 关重来', true)
      }
    } else {
      showBanner('🎉 全部击倒！', '得分 ' + d.score, false)
    }
  })

  api.on('sg:bye', () => {
    aimPoints = []
    effects = []
    shake = 0
    hideBanner()
    cancelAnimationFrame(raf)
  })

  // ---- 输入屏障拖拽：全屏接管鼠标，转发给鱼的弹弓逻辑 ----
  // 这里的坐标相对屏障窗口（=workArea），主进程会换算成鱼窗口内坐标。
  let barrierDown = false
  function localPt(e) {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    barrierDown = true
    try { canvas.setPointerCapture(e.pointerId) } catch (_) {}
    const p = localPt(e)
    if (api.barrierDown) api.barrierDown(p.x, p.y)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!barrierDown) return
    const p = localPt(e)
    if (api.barrierMove) api.barrierMove(p.x, p.y)
  })
  function endDrag(e) {
    if (!barrierDown) return
    barrierDown = false
    try { canvas.releasePointerCapture(e.pointerId) } catch (_) {}
    const p = localPt(e)
    if (api.barrierUp) api.barrierUp(p.x, p.y)
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  const quitBtn = document.getElementById('t-quit')
  if (quitBtn) {
    quitBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    quitBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (api.quit) api.quit()
    })
  }

  // 撞击特效自检探针：在隔离环境生成一次撞击，验证各素材类型齐全 + 方向性 + 震动。
  // 不污染真实 effects/shake——用临时数组+临时 shake，跑完还原。
  function probeImpactFx() {
    const realEffects = effects
    const realShake = shake
    effects = []
    shake = 0
    try {
      addImpactBurst(100, 100, '#e0679a', 1, 0, 1) // 朝正右方撞击
      const kinds = {}
      for (const e of effects) kinds[e.kind] = (kinds[e.kind] || 0) + 1
      // 碎片/火花应整体偏向 +x（撞击方向）
      const dirOk = effects.filter((e) => (e.kind === 'shard' || e.kind === 'spark') && e.vx > 0).length >= 4
      return {
        flash: (kinds.flash || 0) > 0,
        ring: (kinds.ring || 0) >= 2,
        shard: (kinds.shard || 0) >= 10,
        spark: (kinds.spark || 0) >= 6,
        shake: shake > 5,
        dirOk,
        count: effects.length,
      }
    } finally {
      effects = realEffects
      shake = realShake
    }
  }
  window.TargetFxProbe = probeImpactFx
})()
