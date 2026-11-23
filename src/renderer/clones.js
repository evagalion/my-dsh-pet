'use strict'

;(function () {
  const api = window.cloneAPI
  const world = document.getElementById('world')

  const hud = document.getElementById('clone-hud')
  const scoreEl = document.getElementById('hud-score')
  const comboEl = document.getElementById('hud-combo')
  const timeEl = document.getElementById('hud-time')
  const progressEl = document.getElementById('hud-progress-fill')
  const ruleTarget = document.getElementById('rule-target')

  const startPanel = document.getElementById('start-panel')
  const startBtn = document.getElementById('start-btn')
  const overPanel = document.getElementById('over-panel')
  const overEmoji = document.getElementById('over-emoji')
  const overTitle = document.getElementById('over-title')
  const overScore = document.getElementById('over-score')
  const overStats = document.getElementById('over-stats')
  const againBtn = document.getElementById('again-btn')
  const quitBtn = document.getElementById('clone-quit')
  const panelQuits = document.querySelectorAll('.panel-quit')

  // ---- 配置（带默认值，主进程可覆盖）----
  const DEF = {
    durationMs: 45000,
    targetScore: 300,
    baseScore: 10,
    boosterScore: 25,   // 金色特殊鱼分数
    comboWindowMs: 1500,
    maxComboMult: 5,
    fishCount: 7,
    respawnMs: 380,
  }
  let cfg = Object.assign({}, DEF)

  // ---- 运行时状态 ----
  let state = 'ready' // ready | playing | over
  let score = 0
  let combo = 0
  let maxCombo = 0
  let caught = 0
  let timeLeft = 0
  let gameTimer = null
  let clockTimer = null
  let lastCatchAt = 0

  let anims = ['待机呼吸休闲', '轻快摇摆舞', '原地小憩沉眠', '东张西望']
  let clones = []
  let seq = 0
  let hoverAny = false
  let W = window.innerWidth
  let H = window.innerHeight

  const rand = (a) => (a && a.length ? a[Math.floor(Math.random() * a.length)] : null)
  const randBetween = (a, b) => a + Math.random() * (b - a)
  const pickAnim = () => 'pet://' + encodeURIComponent(rand(anims) || anims[0]) + '.webm'

  // ---- 造鱼 ----
  function makeClone(x, y, floor, golden) {
    if (clones.length >= cfg.fishCount + 2) return null
    const id = ++seq
    const el = document.createElement('div')
    el.className = 'clone' + (golden ? ' golden' : '')
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.src = pickAnim()
    v.loop = true
    const spark = document.createElement('span')
    spark.className = 'spark'
    spark.textContent = golden ? '⭐' : '✨'
    el.appendChild(v)
    el.appendChild(spark)
    if (golden) {
      const tag = document.createElement('span')
      tag.className = 'gold-tag'
      tag.textContent = '×' + (Math.round(cfg.boosterScore / cfg.baseScore))
      el.appendChild(tag)
    }
    world.appendChild(el)
    v.play().catch(() => {})

    const c = {
      id, el, v, golden: !!golden,
      x: x == null ? randBetween(W * 0.1, W * 0.82) : x,
      y: y == null ? randBetween(H * 0.2, H * 0.72) : y,
      vx: randBetween(-1, 1) * 90,
      vy: randBetween(-0.6, 0.6) * 55,
      floor: floor == null ? randBetween(H * 0.55, H * 0.92) : floor,
      think: 0,
      dir: 1,
      drag: false,
      offX: 0,
      offY: 0,
      dead: false,
    }
    clones.push(c)
    return c
  }

  function fillSchool() {
    while (clones.length < cfg.fishCount) makeClone()
  }

  function clearSchool() {
    for (const c of clones) { try { c.v.pause() } catch (e) {} try { c.el.remove() } catch (e) {} }
    clones = []
  }

  // ---- 每帧漫游 ----
  let last = performance.now()
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    for (const c of clones) {
      if (c.dead) continue
      if (!c.drag) {
        c.think -= dt
        if (c.think <= 0) {
          c.think = randBetween(1.2, 3.4)
          c.vx = randBetween(-1, 1) * 100
          c.vy = randBetween(-0.6, 0.6) * 55
          if (Math.random() < 0.22) { c.v.src = pickAnim(); c.v.play().catch(() => {}) }
        }
        c.x += c.vx * dt
        c.y += c.vy * dt
      }
      if (c.x < 0) { c.x = 0; c.vx = Math.abs(c.vx) }
      if (c.x > W - 150) { c.x = W - 150; c.vx = -Math.abs(c.vx) }
      if (c.y < 40) { c.y = 40; c.vy = Math.abs(c.vy) }
      if (c.y > c.floor) { c.y = c.floor; c.vy = -Math.abs(c.vy) }
      c.dir = c.vx < 0 ? -1 : 1
      c.el.style.transform = `translate(${c.x}px, ${c.y}px) scaleX(${c.dir})`
    }
    requestAnimationFrame(tick)
  }

  // ---- HUD ----
  function updateHud() {
    scoreEl.textContent = score
    progressEl.style.width = Math.min(100, (score / cfg.targetScore) * 100) + '%'
    if (combo >= 2) {
      comboEl.textContent = '×' + Math.min(combo, cfg.maxComboMult)
      comboEl.classList.toggle('hot', combo >= 3)
    } else {
      comboEl.textContent = '—'
      comboEl.classList.remove('hot')
    }
  }

  function updateTime() {
    const s = Math.max(0, timeLeft / 1000)
    timeEl.textContent = s.toFixed(1) + 's'
    timeEl.classList.toggle('urgent', s <= 10)
  }

  // ---- 抓鱼计分 ----
  function floatScore(x, y, text, big) {
    const f = document.createElement('div')
    f.className = 'float-score' + (big ? ' big' : '')
    f.textContent = text
    f.style.left = x + 'px'
    f.style.top = y + 'px'
    world.appendChild(f)
    setTimeout(() => { try { f.remove() } catch (e) {} }, 900)
  }

  function catchFish(c) {
    if (state !== 'playing' || c.dead) return
    const now = Date.now()
    combo = now - lastCatchAt <= cfg.comboWindowMs ? combo + 1 : 1
    lastCatchAt = now
    if (combo > maxCombo) maxCombo = combo
    const mult = Math.min(combo, cfg.maxComboMult)
    const gain = (c.golden ? cfg.boosterScore : cfg.baseScore) * mult
    score += gain
    caught += 1

    c.dead = true
    c.el.classList.add('caught')
    floatScore(c.x + 70, c.y + 34, '+' + gain, c.golden || combo >= 3)
    updateHud()

    // 音效：普通鱼点一下，金色鱼重一点
    try { api.caught(!!c.golden) } catch (e) {}

    const deadEl = c.el, deadV = c.v
    setTimeout(() => { try { deadEl.remove() } catch (e) {} try { deadV.pause() } catch (e) {} }, 360)
    clones = clones.filter((x) => x !== c)

    // 补一条新鱼，维持鱼群密度；偶尔刷一条金色特殊鱼
    setTimeout(() => {
      if (state !== 'playing') return
      const golden = Math.random() < 0.12
      makeClone(null, null, null, golden)
    }, cfg.respawnMs)
  }

  // ---- 游戏流程 ----
  function startGame() {
    clearSchool()
    score = 0; combo = 0; maxCombo = 0; caught = 0; lastCatchAt = 0
    timeLeft = cfg.durationMs
    state = 'playing'
    startPanel.classList.remove('show')
    overPanel.classList.remove('show')
    hud.classList.add('show')
    updateHud(); updateTime()
    fillSchool()
    // 起手先放一条金色鱼，让规则一眼可见
    makeClone(null, null, null, true)

    clearInterval(gameTimer); clearInterval(clockTimer)
    clockTimer = setInterval(() => {
      if (state !== 'playing') return
      timeLeft -= 100
      updateTime()
      if (timeLeft <= 0) endGame()
    }, 100)
  }

  function endGame() {
    if (state !== 'playing') return
    state = 'over'
    clearInterval(clockTimer); clockTimer = null
    timeEl.classList.remove('urgent')
    const win = score >= cfg.targetScore
    overEmoji.textContent = win ? '🏆' : '💪'
    overTitle.textContent = win ? '大获全胜！' : '差一点点！'
    overScore.textContent = score
    overStats.innerHTML =
      '目标 ' + cfg.targetScore + ' 分 · ' + (win ? '达成啦 🎉' : '再战一次') + '<br>' +
      '抓到 <b>' + caught + '</b> 条 · 最高连击 <b>×' + maxCombo + '</b>'
    overPanel.classList.add('show')
    hud.classList.remove('show')
    clearSchool()
    try { api.over(score, caught, maxCombo, win) } catch (e) {}
  }

  // ---- 鼠标穿透：hover 到「鱼 / HUD / 面板」才接收点击 ----
  function setHover(on) {
    if (on === hoverAny) return
    hoverAny = on
    try { api.hover(on) } catch (e) {}
  }
  function shouldCapture(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY)
    if (!el) return false
    return !!(el.closest('.clone') || el.closest('.clone-hud') || el.closest('.game-panel.show'))
  }
  window.addEventListener('mousemove', (ev) => setHover(shouldCapture(ev)))

  // ---- 点击 / 拖拽（委托）----
  world.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('.clone')
    if (!el) return
    const c = clones.find((x) => x.el === el)
    if (!c || c.dead) return
    c.drag = true
    c.offX = ev.clientX - c.x
    c.offY = ev.clientY - c.y
    try { el.setPointerCapture(ev.pointerId) } catch (e) {}
    ev.preventDefault(); ev.stopPropagation()
  })
  world.addEventListener('pointermove', (ev) => {
    for (const c of clones) {
      if (c.drag) { c.x = ev.clientX - c.offX; c.y = ev.clientY - c.offY }
    }
  })
  window.addEventListener('pointerup', (ev) => {
    let hit = null
    for (const c of clones) {
      if (c.drag) {
        c.drag = false
        const moved = Math.abs(ev.clientX - (c.x + c.offX)) + Math.abs(ev.clientY - (c.y + c.offY))
        if (moved < 8) hit = c
      }
    }
    if (hit) catchFish(hit)
  })

  startBtn.addEventListener('click', startGame)
  againBtn.addEventListener('click', startGame)
  quitBtn.addEventListener('click', () => api.quit())
  for (const b of panelQuits) b.addEventListener('click', () => api.quit())

  // ---- 初始化 ----
  api.on('clone:init', (d) => {
    d = d || {}
    anims = d.anims && d.anims.length ? d.anims : anims
    if (d.game) cfg = Object.assign({}, DEF, d.game)
    W = d.width || W
    H = d.height || H
    ruleTarget.textContent = cfg.targetScore
    timeEl.textContent = (cfg.durationMs / 1000).toFixed(0) + 's'
    fillSchool() // 背景鱼群
    requestAnimationFrame(tick)
  })
  api.on('clone:bye', () => {
    clearInterval(clockTimer)
    clearSchool()
  })

  // 供 CDP / 自检读取内部状态
  window.__cloneGame = {
    snapshot: () => ({ state, score, combo, maxCombo, caught, timeLeft, fish: clones.length }),
    start: startGame,
    catchOne: () => { if (clones.length) catchFish(clones[0]) },
    setTime: (ms) => { timeLeft = ms; updateTime() },
  }

  api.boot()
})()
