'use strict'

;(function () {
  const api = window.petAPI
  const stage = document.getElementById('stage')
  const hit = document.getElementById('hit')
  const vids = [document.getElementById('v-a'), document.getElementById('v-b')]
  const bubble = document.getElementById('bubble')
  const bubbleText = document.getElementById('bubble-text')
  const bubbleAgent = document.getElementById('bubble-agent')
  const bubbleWhat = document.getElementById('bubble-what')
  const bubbleMeta = document.getElementById('bubble-meta')
  const bubbleStep = document.getElementById('bubble-step')

  let cfg = null
  let pool = null
  let active = 0
  let token = 0
  let phase = 'idle'
  let phaseTimer = null
  let bubbleTimer = null
  let bubbleKey = '' // 当前气泡台词对应的「agent|档位」，用来防止步骤刷新时台词乱跳
  let bubbleLine = ''
  let hovering = false
  let suppressHover = false
  let manualUntil = 0 // 手动点播后短暂屏蔽状态机，别刚点就被工作状态抢回去
  let fullness = null // 饱腹度，主进程给的（开机一次 + 每次喂食后更新）

  const rand = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

  function play(name, opts) {
    if (!name) return
    opts = opts || {}
    const next = vids[1 - active]
    const cur = vids[active]
    const my = ++token

    next.loop = !!opts.loop
    next.onended = null
    next.src = 'pet://' + encodeURIComponent(name) + '.webm'
    try {
      next.currentTime = 0
    } catch (e) {
      /* noop */
    }
    const pr = next.play()
    if (pr && pr.catch) pr.catch(() => {})

    next.classList.add('show')
    cur.classList.remove('show')
    active = 1 - active

    if (!opts.loop) {
      next.onended = () => {
        if (my !== token) return
        if (opts.onEnd) opts.onEnd()
        else nextIdle()
      }
    }
  }

  function pickWeighted() {
    const w = cfg.weights || {}
    const cand = [
      [w.idle || 0, pool.idle],
      [w.turn || 0, pool.turn],
      [w.move || 0, pool.move],
      [w.whisper || 0, pool.whisper],
      [w.fun || 0, pool.fun],
    ].filter((c) => c[0] > 0 && c[1] && c[1].length)

    if (!cand.length) return rand(pool.fun) || rand(pool.idle)
    const total = cand.reduce((s, c) => s + c[0], 0)
    let r = Math.random() * total
    for (const c of cand) {
      r -= c[0]
      if (r <= 0) return rand(c[1])
    }
    return rand(cand[cand.length - 1][1])
  }

  function nextIdle() {
    if (phase !== 'idle') return
    // 饿了就时不时自己嘟囔一句，不用等到你去点菜单才知道
    const f = cfg.feed || {}
    const hungryAt = f.hungryAt == null ? 25 : f.hungryAt
    if (
      f.enabled !== false &&
      fullness != null &&
      fullness <= hungryAt &&
      pool.whisper.length &&
      Math.random() < 0.45
    ) {
      play(rand(pool.whisper), {})
      const lines = (f.lines || {}).hungry
      showBubble(rand(lines) || '肚子饿了…', null, 2600)
      return
    }
    play(pickWeighted(), {})
  }

  const clip = (s, n) => {
    s = String(s || '')
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  // 每个 agent 有自己的一套说法：先查 textsBySource[source][phase]，查不到再退回通用 texts
  function textsFor(source, ph) {
    const by = cfg.textsBySource || {}
    const a = by[source]
    if (a && a[ph] && a[ph].length) return a[ph]
    return cfg.texts[ph] || []
  }

  // 气泡：徽章（哪个 agent）+ 在处理哪个问题 + 文案 + 档位/文件
  function showBubble(text, s, ms) {
    s = s || {}
    clearTimeout(bubbleTimer)

    const ag = (cfg.agents || {})[s.source]
    if (ag && ag.label) {
      bubbleAgent.textContent = ag.label
      bubbleAgent.style.background = ag.color || '#8a8a8a'
      bubbleAgent.style.display = 'inline-block'
    } else {
      bubbleAgent.textContent = ''
      bubbleAgent.style.display = 'none'
    }

    const what = s.title || s.project || ''
    bubbleWhat.textContent = what ? clip(what, 26) : ''
    bubbleWhat.style.display = what ? 'inline' : 'none'

    // 它这一步具体在干嘛（读哪个文件 / 跑哪条命令），没有就不占位置
    const step = s.step || ''
    bubbleStep.textContent = step ? '› ' + step : ''
    bubbleStep.style.display = step ? 'block' : 'none'

    const pl = (cfg.phases[s.phase] || {}).label || ''
    const meta = pl + (s.detail ? ' · ' + clip(s.detail, 22) : '')
    bubbleMeta.textContent = meta
    bubbleMeta.style.display = meta ? 'block' : 'none'

    bubbleText.textContent = text || ''
    bubble.classList.add('show')
    if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms)
  }

  function hideBubble() {
    clearTimeout(bubbleTimer)
    bubble.classList.remove('show')
  }

  function squish() {
    const v = vids[active]
    v.classList.remove('squish')
    void v.offsetWidth
    v.classList.add('squish')
  }

  function onState(s) {
    if (Date.now() < manualUntil && !(s && s.force)) return
    const prev = phase
    phase = s.phase || 'idle'
    clearTimeout(phaseTimer)

    if (phase !== 'idle') {
      const anim = pool.phase[phase]
      if (anim && (prev !== phase || s.force)) play(anim, { loop: true })
      // 步骤每变一次都会推一次状态，但台词不能跟着乱跳：
      // 同一个 agent 的同一个档位一直用同一句，只有切档/换人才重抽。
      const key = (s.source || '') + '|' + phase
      if (key !== bubbleKey) {
        bubbleKey = key
        const texts = textsFor(s.source, phase)
        bubbleLine = texts.length ? rand(texts) : (cfg.phases[phase] || {}).label || ''
      }
      const transient = phase === 'success' || phase === 'error'
      showBubble(bubbleLine, s, transient ? 6000 : 0)
      if (transient) {
        phaseTimer = setTimeout(() => {
          phase = 'idle'
          hideBubble()
          nextIdle()
        }, 6000)
      }
    } else if (prev !== 'idle' || s.force) {
      bubbleKey = ''
      hideBubble()
      nextIdle()
    }
  }

  // ---- 交互 ----
  let dragging = false
  let downAt = 0
  let movedDist = 0
  let lastMoveAt = 0
  let vel = [0, 0]
  let lastX = null
  let lastY = null
  let accX = 0
  let accY = 0

  const dbg = (ev, extra) => {
    if (api.debug) api.debug({ ev, ...extra })
  }

  stage.addEventListener('pointerdown', (e) => {
    dbg('pointerdown', {
      button: e.button,
      movementX: e.movementX,
      screenX: e.screenX,
      clientX: e.clientX,
      clientY: e.clientY,
    })
    if (e.button !== 0) return
    dragging = true
    suppressHover = true
    downAt = performance.now()
    lastX = typeof e.screenX === 'number' ? e.screenX : null
    lastY = typeof e.screenY === 'number' ? e.screenY : null
    lastMoveAt = performance.now()
    movedDist = 0
    vel = [0, 0]
    accX = 0
    accY = 0
    try {
      stage.setPointerCapture(e.pointerId)
    } catch (err) {
      /* noop */
    }
    hideBubble()
    if (pool.drag.length) play(pool.drag[0], { loop: true })
  })

  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return

    // movementX/Y 是浏览器给的原生位移，最可靠；拿不到就退回 screenX 差值
    let dx = typeof e.movementX === 'number' ? e.movementX : 0
    let dy = typeof e.movementY === 'number' ? e.movementY : 0
    if (!dx && !dy && lastX !== null && typeof e.screenX === 'number') {
      dx = e.screenX - lastX
      dy = e.screenY - lastY
    }
    if (lastX !== null && typeof e.screenX === 'number') {
      lastX = e.screenX
      lastY = e.screenY
    }

    if (!dx && !dy) return

    dbg('pointermove', { dx, dy, movedDist })
    const now = performance.now()
    const dt = Math.max(4, now - lastMoveAt) / 1000
    lastMoveAt = now
    movedDist += Math.abs(dx) + Math.abs(dy)

    // 指数平滑，避免最后一帧抖动决定飞行方向
    vel[0] = vel[0] * 0.55 + (dx / dt) * 0.45
    vel[1] = vel[1] * 0.55 + (dy / dt) * 0.45

    // Retina 下位移是小数，窗口坐标只吃整数：把零头攒起来，凑够 1px 再发
    accX += dx
    accY += dy
    const ix = Math.trunc(accX)
    const iy = Math.trunc(accY)
    accX -= ix
    accY -= iy
    if (ix || iy) api.moveBy(ix, iy)
  })

  stage.addEventListener('pointerup', (e) => {
    if (!dragging) return
    dbg('pointerup', { movedDist, vel })
    dragging = false
    suppressHover = false
    try {
      stage.releasePointerCapture(e.pointerId)
    } catch (err) {
      /* noop */
    }

    const dur = performance.now() - downAt
    if (movedDist < 8 && dur < 400) {
      api.dragEnd()
      poke()
      return
    }

    const [vx, vy] = vel
    if (Math.abs(vx) > 280 || Math.abs(vy) > 280) {
      api.throw(vx, vy)
    } else {
      api.dragEnd()
      land()
    }
  })

  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.openMenu()
  })

  function updateHover(e) {
    const r = hit.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (inside !== hovering) {
      hovering = inside
      api.hover(inside)
    }
  }

  stage.addEventListener('mousemove', updateHover)
  window.addEventListener('mousemove', updateHover)

  stage.addEventListener('pointerleave', () => {
    if (hovering) {
      hovering = false
      api.hover(false)
    }
  })

  function poke() {
    api.click() // 点一下出声。音效在主进程播，不经过渲染层
    const a = rand(pool.clicks)
    play(a || pickWeighted(), {
      onEnd: () => nextIdle(),
    })
    squish()
    showBubble(rand(cfg.idleTexts) || '', null, 2600)
  }

  function land() {
    const a = pool.fun.indexOf('原地重力下蹲压缩') >= 0 ? '原地重力下蹲压缩' : null
    play(a || pickWeighted(), { onEnd: () => nextIdle() })
    squish()
  }

  // ---- 启动 ----
  // 右键菜单点播：走路类的会真的挪一段，其余播完回到待机链
  function playByName(name) {
    manualUntil = Date.now() + 9000
    clearTimeout(phaseTimer)
    hideBubble()
    phase = 'idle'
    if (pool.move.indexOf(name) >= 0) {
      const dist = (Math.random() < 0.5 ? -1 : 1) * (130 + Math.floor(Math.random() * 170))
      play(name, { loop: true })
      api.walk(dist, 2600)
    } else {
      play(name, { onEnd: () => nextIdle() })
    }
  }

  // 喂食：先把食物从角落飘到鱼嘴边，再播"吃XX"动画
  function onFeed(d) {
    if (!d || !d.food) return
    fullness = d.fullness
    manualUntil = Date.now() + 9000
    clearTimeout(phaseTimer)
    hideBubble()
    phase = 'idle'
    if (pool.fun.indexOf(d.food) < 0) {
      // 素材里没这段（比如改名了），退化成随便播一个，别卡住
      play(pickWeighted(), { onEnd: () => nextIdle() })
      return
    }
    flyIn(d.food)
    setTimeout(() => {
      play(d.food, { onEnd: () => nextIdle() })
      showBubble(d.line || '', null, 2600)
    }, 520)
  }

  // 食物标签：从右上角飘到中间，再淡掉。纯 CSS 过渡，不用新素材
  let foodTimer = null
  function flyIn(foodName) {
    const el = document.getElementById('food')
    if (!el) return
    clearTimeout(foodTimer)
    el.textContent = foodName.replace(/^吃/, '')
    el.classList.remove('gone')
    el.classList.add('show')
    foodTimer = setTimeout(() => {
      el.classList.add('gone')
      foodTimer = setTimeout(() => el.classList.remove('show', 'gone'), 400)
    }, 620)
  }

  api.on('pet:feed', onFeed)
  api.on('pet:play', playByName)
  api.on('pet:walk-done', () => {
    manualUntil = Date.now() + 2500
    land()
  })
  api.on('pet:state', onState)
  api.on('pet:poke', poke)
  api.on('pet:landed', land)
  api.on('pet:speak', (s) => onState(Object.assign({}, s, { force: true })))
  api.on('pet:reload-config', (payload) => {
    cfg = payload.config || cfg
    if (payload.pools) pool = payload.pools
    hideBubble()
    phase = 'idle'
    nextIdle()
  })

  function selftestReport(boot, extra) {
    if (!api.selftest) return
    const v = vids[active]
    api.selftest(
      Object.assign(
        {
          assets: (boot.assets || []).length,
          phases: Object.keys(pool.phase),
          pools: {
            idle: pool.idle.length,
            fun: pool.fun.length,
            clicks: pool.clicks.length,
            drag: pool.drag.length,
            move: pool.move.length,
            whisper: pool.whisper.length,
          },
          anim: v ? v.src : '',
          currentTime: v ? Number(v.currentTime.toFixed(2)) : -1,
          videoSize: v ? [v.videoWidth, v.videoHeight] : [0, 0],
        },
        extra || {}
      )
    )
  }

  window.addEventListener('error', (e) => {
    if (api.selftest) api.selftest({ fatal: String(e.message || e) })
  })

  api.boot().then((boot) => {
    cfg = boot.config
    pool = boot.pools
    if (typeof boot.fullness === 'number') fullness = boot.fullness
    const first = rand(pool.idle) || rand(pool.fun) || (boot.assets || [])[0]
    play(first, {})
    const v = vids[active]
    v.addEventListener('playing', () => selftestReport(boot, { playing: true }), { once: true })
    v.addEventListener('error', () => selftestReport(boot, { playing: false, err: 'media error' }), {
      once: true,
    })
    setTimeout(() => selftestReport(boot, { note: 'fallback-timeout' }), 12000)
  })
})()
