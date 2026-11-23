'use strict'

;(function () {
  const api = window.aquariumAPI
  const fishLayer = document.getElementById('fish-layer')
  const bubbles = document.getElementById('bubbles')
  const foodLayer = document.getElementById('food-layer')
  const coinsEl = document.getElementById('aq-coins')
  const growthEl = document.getElementById('aq-growth')
  const levelEl = document.getElementById('aq-level')
  const feedBtn = document.getElementById('aq-feed')
  const shopBtn = document.getElementById('aq-shop-btn')
  const shop = document.getElementById('shop')
  const closeBtn = document.getElementById('aq-close')

  let W = window.innerWidth
  let snap = null
  let fish = []

  // 气泡背景
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('div')
    b.className = 'bubble'
    const size = 3 + Math.random() * 7
    b.style.width = size + 'px'
    b.style.height = size + 'px'
    b.style.left = Math.random() * 100 + '%'
    b.style.animationDuration = (5 + Math.random() * 6) + 's'
    b.style.animationDelay = (-Math.random() * 8) + 's'
    bubbles.appendChild(b)
  }

  function syncFish(list) {
    // 按已解锁鱼种重建鱼群（每个鱼种 1~2 只）
    fishLayer.innerHTML = ''
    fish = []
    const owned = list.filter((s) => s.owned)
    owned.forEach((sp, i) => {
      const count = i === 0 ? 3 : 2
      for (let k = 0; k < count; k++) {
        const el = document.createElement('div')
        el.className = 'afish'
        el.textContent = sp.emoji
        el.title = sp.name
        fishLayer.appendChild(el)
        fish.push({
          el,
          x: Math.random() * (W - 60),
          y: 30 + Math.random() * 90,
          vx: (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 26),
          vy: (Math.random() - 0.5) * 8,
          phase: Math.random() * Math.PI * 2,
        })
      }
    })
  }

  let last = performance.now()
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    for (const f of fish) {
      f.phase += dt * 2
      f.x += f.vx * dt
      f.y += f.vy * dt + Math.sin(f.phase) * 0.15
      if (f.x < -40) f.x = W + 30
      if (f.x > W + 30) f.x = -40
      if (f.y < 18) { f.y = 18; f.vy = Math.abs(f.vy) }
      if (f.y > 150) { f.y = 150; f.vy = -Math.abs(f.vy) }
      const dir = f.vx < 0 ? -1 : 1
      f.el.style.transform = `translate(${f.x}px, ${f.y}px) scaleX(${dir})`
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  function renderShop() {
    if (!snap) return
    shop.innerHTML = ''
    for (const sp of snap.species) {
      const el = document.createElement('div')
      el.className = 'shop-item' + (sp.owned ? ' owned' : '')
      el.innerHTML =
        `<div class="em">${sp.emoji}</div>` +
        `<div class="nm">${sp.name}</div>` +
        (sp.owned
          ? '<div class="pr owned-tag">已拥有</div>'
          : `<div class="pr">🪙 ${sp.cost} · ${sp.rate}/分</div>`)
      if (!sp.owned) {
        el.addEventListener('click', async () => {
          const r = await api.unlock(sp.id)
          if (r && r.ok) {
            await refresh()
            renderShop()
          } else if (r) {
            flash(r.reason || '金币不够')
          }
        })
      }
      shop.appendChild(el)
    }
    const foot = document.createElement('div')
    foot.className = 'shop-foot'
    if (snap.level >= snap.maxLevel) {
      foot.innerHTML = '<span>鱼缸已满级 · 产币最大化</span>'
    } else {
      const btn = document.createElement('button')
      btn.textContent = `升级鱼缸 Lv.${snap.level}→${snap.level + 1} · 🪙 ${snap.upCost}`
      btn.disabled = snap.coins < snap.upCost
      btn.addEventListener('click', async () => {
        const r = await api.upgrade()
        if (r && r.ok) { await refresh(); renderShop() }
        else if (r) flash(r.reason || '金币不够')
      })
      foot.appendChild(btn)
    }
    shop.appendChild(foot)
  }

  let flashTimer = null
  function flash(msg) {
    feedBtn.textContent = msg
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { if (snap) feedBtn.textContent = snap.feedWaitSec > 0 ? `撒鱼食 ${snap.feedWaitSec}s` : '撒鱼食' }, 1600)
  }

  function dropFood() {
    for (let i = 0; i < 12; i++) {
      const c = document.createElement('div')
      c.className = 'crumb'
      c.style.left = (W * 0.25 + Math.random() * W * 0.5) + 'px'
      c.style.top = '-10px'
      c.style.animationDelay = (Math.random() * 0.4) + 's'
      foodLayer.appendChild(c)
      setTimeout(() => c.remove(), 3200)
    }
  }

  async function refresh() {
    snap = await api.boot()
    if (!snap || snap.enabled === false) return
    coinsEl.textContent = snap.coins
    growthEl.textContent = snap.growth
    levelEl.textContent = snap.level
    if (snap.feedWaitSec > 0) {
      feedBtn.disabled = true
      feedBtn.textContent = `撒鱼食 ${snap.feedWaitSec}s`
    } else {
      feedBtn.disabled = false
      feedBtn.textContent = '撒鱼食'
    }
    syncFish(snap.species)
  }

  feedBtn.addEventListener('click', async () => {
    const r = await api.feed()
    if (r && r.ok) {
      dropFood()
      flash('+🪙 ' + r.coins)
      await refresh()
    } else if (r) {
      flash(`还要 ${r.waitSec}s`)
    }
  })
  shopBtn.addEventListener('click', () => {
    renderShop()
    shop.classList.toggle('show')
  })
  closeBtn.addEventListener('click', () => api.close())

  api.on('aq:snapshot', (d) => { if (d) { snap = d; refresh() } })

  refresh()
  // 每秒刷一次冷却倒计时与金币（不重建鱼，避免闪烁）
  setInterval(async () => {
    const r = await api.boot()
    if (!r || r.enabled === false) return
    coinsEl.textContent = r.coins
    growthEl.textContent = r.growth
    if (r.feedWaitSec > 0) {
      feedBtn.disabled = true
      if (r.feedWaitSec !== snap.feedWaitSec) feedBtn.textContent = `撒鱼食 ${r.feedWaitSec}s`
    } else if (feedBtn.disabled) {
      feedBtn.disabled = false
      feedBtn.textContent = '撒鱼食'
    }
    snap = r
  }, 1000)
})()
