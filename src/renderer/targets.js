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
  let effects = [] // 命中爆裂粒子 / 飘字
  let aimPoints = [] // 全屏瞄准弹道（相对本窗口坐标）
  let raf = 0

  function resize(w, h) {
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
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
    // 特效
    for (const e of effects) {
      if (e.kind === 'puff') {
        ctx.globalAlpha = Math.max(0, e.life / e.max)
        ctx.fillStyle = e.color
        ctx.beginPath()
        ctx.arc(e.x, e.y, e.size * (1.4 - e.life / e.max), 0, Math.PI * 2)
        ctx.fill()
      } else if (e.kind === 'float') {
        ctx.globalAlpha = Math.max(0, Math.min(1, e.life))
        ctx.fillStyle = '#e0679a'
        ctx.font = '700 20px -apple-system, "PingFang SC", sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(e.text, e.x, e.y)
      }
    }
    ctx.globalAlpha = 1
    // 推进
    for (const e of effects) {
      e.life -= 1 / 60
      if (e.kind === 'puff') {
        e.x += e.vx / 60
        e.y += e.vy / 60
        e.vy += 900 / 60
      } else {
        e.y -= 40 / 60
      }
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
    targets = (d.targets || []).map((t) => Object.assign({}, t, { maxHp: t.hp || 1 }))
    scoreEl.textContent = '得分 ' + (d.score || 0)
    const roundTag = d.cycle > 0 ? ' · 第' + (d.cycle + 1) + '轮' : ''
    const moveTag = d.moving ? ' · 移动靶' : ''
    levelEl.textContent = '第 ' + (d.level || 1) + ' 关 · ' + (d.name || '') + roundTag + moveTag
    setAmmo(d.ammo)
    hideBanner()
    effects = []
    aimPoints = []
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

  api.on('sg:hit', (d) => {
    const t = targets.find((x) => x.id === d.id)
    // 装甲罐掉一层：更新 hp、闪一下、少量火花，不碎、不飘分
    if (d.cracked) {
      if (t) { t.hp = d.hp; t.hitFlash = 1 }
      const colors = ['#fff', '#9aa7b4', '#d9e2ea']
      for (let i = 0; i < 6; i++) {
        effects.push({
          kind: 'puff', x: d.x, y: d.y,
          vx: (Math.random() - 0.5) * 260, vy: -60 - Math.random() * 180,
          size: 2 + Math.random() * 3, color: colors[i % colors.length],
          life: 0.35 + Math.random() * 0.2, max: 0.55,
        })
      }
      return
    }
    // 正常击碎
    scoreEl.textContent = '得分 ' + d.score
    if (t) { t.alive = false; t.hitFlash = 1 }
    const colors = ['#e0679a', '#378add', '#f2a93b', '#7b6cd4', '#4c9e6a', '#fff']
    for (let i = 0; i < 14; i++) {
      effects.push({
        kind: 'puff',
        x: d.x,
        y: d.y,
        vx: (Math.random() - 0.5) * 420,
        vy: -80 - Math.random() * 320,
        size: 3 + Math.random() * 5,
        color: colors[i % colors.length],
        life: 0.6 + Math.random() * 0.3,
        max: 0.9,
      })
    }
    effects.push({ kind: 'float', x: d.x, y: d.y - 10, text: '+' + d.pts, life: 1.1 })
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
})()
