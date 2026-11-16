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
  const noteTag = document.getElementById('bubble-note-tag')

  let cfg = null
  let pool = null
  let active = 0
  let token = 0
  let phase = 'idle'
  let phaseTimer = null
  let rotateTimer = null // 同一档位内部轮换动画的定时器，切档或回 idle 时要清掉
  let bubbleTimer = null
  let bubbleKey = '' // 当前气泡台词对应的「agent|档位」，用来防止步骤刷新时台词乱跳
  let bubbleLine = ''
  let manualUntil = 0 // 手动点播后短暂屏蔽状态机，别刚点就被工作状态抢回去
  let fullness = null // 饱腹度，主进程给的（开机一次 + 每次喂食后更新）
  // 心情快照：mood=最近顺不顺，sulking=连续失败正在赌气，bond=亲密度
  let moodSnap = { enabled: true, mood: 'calm', sulking: false, bond: null, level: null }
  let holdLine = '' // 「卡太久」这类提醒要在几秒内压住状态机的台词，不然下一秒就被冲掉
  let holdUntil = 0
  let occasion = null // 今天过什么节（含应季动作），主进程下发，一天一变

  const rand = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

  // 台词用的「洗牌袋」：一轮里不重复，抽完才重新洗。
  // 纯随机的问题不是句子少，是**体感重复**——5 句话随机也会连着说同一句，
  // 抽袋能保证 48 句里至少轮过一遍才可能重复。
  // 每个 key 一个袋子，key 相同才共享（比如「戳它的闲聊」和「悬停台词」互不干扰）
  const bags = {}
  function pickNoRepeat(arr, key) {
    const list = (arr || []).filter((s) => s != null && s !== '')
    if (!list.length) return ''
    if (list.length === 1) return list[0]
    const sig = list.join('')
    let b = bags[key]
    if (!b || b.sig !== sig) b = bags[key] = { sig, pool: [], last: '' }
    if (!b.pool.length) {
      b.pool = list.slice()
      for (let i = b.pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = b.pool[i]
        b.pool[i] = b.pool[j]
        b.pool[j] = t
      }
      // 跨轮接缝：新袋子的第一张别跟上个袋子的最后一张撞上
      if (b.last && b.pool.length > 1 && b.pool[0] === b.last) {
        const t = b.pool[0]
        b.pool[0] = b.pool[1]
        b.pool[1] = t
      }
    }
    b.last = b.pool.shift()
    return b.last
  }
  // pet://xxx.webm → 素材名（自检里用来断言播的到底是哪一段）
  const nameOf = (src) =>
    decodeURIComponent(String(src || '').replace(/^pet:\/*/i, '')).replace(/\.webm$/, '')

  // 素材走 pet:// 协议，换 src 之后要异步解码。早先是「立刻隐藏旧 video、显示新 video」，
  // 解码空窗里两个都不出画面，整窗透明，用户看到的就是「只剩文字、鱼不见了」；
  // 更要命的是 play() 失败被吞掉、onended 又没来时，播放链会停死在空白帧再也回不来。
  // 现在等新视频首帧就绪才切，旧画面一直留着；超时/报错/play 被拒都有兜底把链往下推。
  function play(name, opts) {
    if (!name) return
    opts = opts || {}
    const next = vids[1 - active]
    const my = ++token
    let shown = false
    let advanced = false
    let guard = null

    const reveal = () => {
      if (my !== token || shown) return
      shown = true
      if (guard) clearTimeout(guard)
      // 按当前 active 统一收口：快速连点时被打断的那次不会把 show 留在错的元素上
      vids.forEach((v, i) => v.classList.toggle('show', i === active))
      // 画面已经出来了，但 onended 万一不来（解码卡住 / 媒体僵住）也别让状态机停死：
      // 把短超时换成长看门狗，素材普遍 10 秒，给 12 秒余量
      if (!opts.loop) {
        guard = setTimeout(() => {
          if (my !== token) return
          advance()
        }, (cfg.pet && cfg.pet.playStallMs) || 12000)
      }
    }
    const advance = () => {
      if (my !== token || advanced) return
      advanced = true
      if (guard) clearTimeout(guard)
      if (opts.onEnd) opts.onEnd()
      else nextIdle()
    }

    next.loop = !!opts.loop
    next.onended = null
    next.onloadeddata = reveal
    next.oncanplay = reveal // 双保险：个别情况下只来 canplay 不来 loadeddata
    next.onerror = () => {
      // 加载失败时绝不能把 show 挪到这个空元素上：旧画面继续留着，只把播放链往下推
      if (my === token) advance()
    }
    next.src = 'pet://' + encodeURIComponent(name) + '.webm'
    try {
      next.currentTime = 0
    } catch (e) {
      /* noop */
    }
    const pr = next.play()
    if (pr && pr.catch)
      pr.catch(() => {
        // 被下一次 play 打断是正常现象（my !== token），只有真失败才需要兜底推进
        if (my === token) advance()
      })

    // 逻辑上的 current 立刻切换：自检靠它同步读到本次播的到底是哪段素材
    active = 1 - active

    guard = setTimeout(() => {
      if (my !== token || advanced) return
      // 解码迟迟不来 / 事件没触发，也要让播放链继续，别停死。
      // 只要屏幕上还有一帧看得见的旧画面就别抢着换，开机第一帧没画面时才强制切
      const visibleFrame = vids.some((v) => v.classList.contains('show') && v.readyState >= 2)
      if (next.readyState >= 2 || !visibleFrame) reveal()
      if (!opts.loop) advance()
    }, (cfg.pet && cfg.pet.playGuardMs) || 1500)

    if (!opts.loop) {
      next.onended = () => {
        if (my !== token) return
        reveal()
        advance()
      }
    }
  }

  // 待机动画链：先按权重选池，再在池内抽。
  //
  // 权重是按「池」给的，不是按段数——所以段少的池每段概率会暴涨。
  // 修 fun 权重之前，「东张西望」一个人就占了 13%（turn 池只有它一段却给了 4 的权重），
  // 而 74 段的趣味池每段只有 0.4%，观感就是来回来去那几段。
  //
  // 池内也走洗牌袋：49 段趣味素材会轮过一遍才可能重复。
  const WEIGHT_POOLS = ['idle', 'turn', 'move', 'whisper', 'fun']
  function pickWeighted() {
    const w = cfg.weights || {}
    const cand = WEIGHT_POOLS.map((k) => [k, w[k] || 0, pool[k]]).filter(
      (c) => c[1] > 0 && c[2] && c[2].length
    )

    if (!cand.length) return pickNoRepeat(pool.fun, 'anim:fun') || rand(pool.idle)
    const total = cand.reduce((s, c) => s + c[1], 0)
    let r = Math.random() * total
    for (const c of cand) {
      r -= c[1]
      if (r <= 0) return pickNoRepeat(c[2], 'anim:' + c[0])
    }
    const last = cand[cand.length - 1]
    return pickNoRepeat(last[2], 'anim:' + last[0])
  }

  // 命中区尺寸写在配置里：不同动画里鱼的姿态不一样，写死不通用。
  // 改完右键「重载配置」就能看到新的可点范围
  function applyHitArea() {
    const a = (cfg.pet && cfg.pet.hitArea) || {}
    hit.style.left = (a.left == null ? 30 : a.left) + '%'
    hit.style.right = (a.right == null ? 30 : a.right) + '%'
    hit.style.bottom = (a.bottom == null ? 3 : a.bottom) + '%'
    hit.style.height = (a.height == null ? 52 : a.height) + '%'
    hit.style.borderRadius = a.radius || '48% 48% 30% 30% / 38% 38% 22% 22%'
    layoutBubble()
  }

  // 气泡要贴着头顶，不能钉在窗口顶部。
  //
  // 素材是 640x360，按 object-fit:contain + bottom 贴底显示的：320x280 的窗口里
  // 实际只画了下面 180px，上面 100px 全是透明像素。所以写 top:2px 的话气泡会飘在
  // 离头顶七十多像素的半空中。这里按窗口尺寸现算头顶在窗口里的 y，再定气泡底边。
  const FRAME = { w: 640, h: 360 }
  function headTopPx() {
    const b = (cfg && cfg.pet && cfg.pet.bubble) || {}
    const ratio = b.headTop == null ? 0.175 : b.headTop // 头顶在素材里的高度比例（量出来 y≈63/360）
    const W = window.innerWidth || FRAME.w
    const H = window.innerHeight || FRAME.h
    const s = Math.min(W / FRAME.w, H / FRAME.h) // contain 的缩放比
    return H - FRAME.h * s + ratio * FRAME.h * s
  }
  function layoutBubble() {
    const b = (cfg && cfg.pet && cfg.pet.bubble) || {}
    const gap = b.gap == null ? 6 : b.gap // 气泡底边离头顶留多少 px
    const H = window.innerHeight || FRAME.h
    const bottom = Math.max(0, Math.round(H - headTopPx() + gap))
    document.documentElement.style.setProperty('--bubble-bottom', bottom + 'px')
  }
  // 窗口尺寸改了（配置里改了 pet.width/height）要重算，不然气泡又飘回半空
  window.addEventListener('resize', layoutBubble)

  // 亲密度够到哪一档，就能解锁那一档的台词
  function bondLevelNow() {
    const b = cfg.bond || {}
    if (b.enabled === false || moodSnap.bond == null) return null
    let hit = null
    for (const lv of b.levels || []) if (moodSnap.bond >= (lv.at || 0)) hit = lv
    return hit
  }

  function nextIdle() {
    if (phase !== 'idle') return
    // 今天过节就时不时来一段应景的（中秋赏月、堆雪人、讨糖南瓜灯…），
    // 这些素材本来就有，不接进来就只能躺在 assets 里
    if (occasion && occasion.anims && occasion.anims.length) {
      const ch = ((cfg.calendar || {}).chance || {})[occasion.kind]
      const p = ch == null ? (occasion.kind === 'festival' ? 0.35 : 0.12) : ch
      if (Math.random() < p) {
        play(pickNoRepeat(occasion.anims, 'anim:occasion'), { onEnd: () => nextIdle() })
        return
      }
    }
    // 心情好就时不时雀跃一下，蔫了就垂头叹气——不用等到真的成功/失败才看得出来
    const m = cfg.mood || {}
    if (m.enabled !== false && Math.random() < (m.idleChance == null ? 0.3 : m.idleChance)) {
      const anims = ((m.anims || {})[moodSnap.mood]) || []
      if (anims.length) {
        const a = pickNoRepeat(anims, 'anim:mood-' + moodSnap.mood)
        play(a, { onEnd: () => nextIdle() })
        if (moodSnap.mood === 'sad' && Math.random() < 0.5) {
          showBubble(pickNoRepeat((m.lines || {}).sad, 'mood-sad') || '唉…', null, 2600)
        }
        return
      }
    }
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
      play(pickNoRepeat(pool.whisper, 'anim:whisper'), {})
      const lines = (f.lines || {}).hungry
      showBubble(pickNoRepeat(lines, 'feed-hungry') || '肚子饿了…', null, 2600)
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
    // 便签样式是"一次性"的：这次显示完（含被下一次普通气泡打断）就恢复成普通气泡
    bubble.classList.toggle('note', !!s.note)
    if (s.note) noteTag.textContent = s.note === true ? '小纸条' : s.note
    bubble.classList.add('show')
    if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms)
  }

  function hideBubble() {
    clearTimeout(bubbleTimer)
    bubble.classList.remove('show')
    bubble.classList.remove('note')
  }

  function squish() {
    const v = vids[active]
    v.classList.remove('squish')
    void v.offsetWidth
    v.classList.add('squish')
  }

  // 同一档位持续太久只播一段会腻（working 一播就是几分钟），
  // 配了 rotateMs 就在档位内部换一段接着 loop
  function playPhase(ph) {
    const anims = pool.phase[ph] || []
    if (!anims.length) return
    play(pickNoRepeat(anims, 'anim:phase-' + ph), { loop: true })
    clearRotate()
    const ms = ((cfg.phases || {})[ph] || {}).rotateMs || 0
    if (ms > 0 && anims.length > 1) {
      rotateTimer = setTimeout(() => {
        if (phase === ph && Date.now() >= manualUntil) playPhase(ph)
      }, ms)
    }
  }

  function clearRotate() {
    clearTimeout(rotateTimer)
    rotateTimer = null // 置空才能区分「有定时器」和「清过了」，自检靠这个判断
  }

  function onState(s) {
    if (Date.now() < manualUntil && !(s && s.force)) return
    const prev = phase
    phase = s.phase || 'idle'
    clearTimeout(phaseTimer)
    // 关键：状态每秒推一次，同档位续播时**不能**清轮换定时器，
    // 否则刚进档位挂上的定时器下一秒就被冲掉，轮换永远触发不了
    if (phase === 'idle' || prev !== phase || s.force) clearRotate()

    if (phase !== 'idle') {
      if (prev !== phase || s.force) playPhase(phase)
      // 步骤每变一次都会推一次状态，但台词不能跟着乱跳：
      // 同一个 agent 的同一个档位一直用同一句，只有切档/换人才重抽。
      const key = (s.source || '') + '|' + phase
      if (key !== bubbleKey) {
        bubbleKey = key
        const texts = textsFor(s.source, phase)
        bubbleLine = texts.length
          ? pickNoRepeat(texts, `phase:${s.source || ''}:${phase}`)
          : (cfg.phases[phase] || {}).label || ''
      }
      const transient = phase === 'success' || phase === 'error'
      // 提醒类台词（卡太久）在几秒内优先级最高，不然每秒一次的状态推送会把它冲掉
      const line = Date.now() < holdUntil && holdLine ? holdLine : bubbleLine
      showBubble(line, s, transient ? 6000 : 0)
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

  // 悬停反应：鼠标在鱼身上停住一会儿它会害羞。
  // 命中区收窄到 128x146 之后这个才有意义——之前整个窗口都是命中区，hover 没有语义
  let hoverTimer = null
  let hoverFiredAt = 0
  // 抽成单独的函数，自检里能跳过定时器直接验证它播的对不对
  function fireHover() {
    const h = cfg.hover || {}
    if (h.enabled === false) return
    // 只在闲着的时候回应：正播工作状态动画就别抢戏
    if (phase !== 'idle' || Date.now() < manualUntil) return
    if (Date.now() - hoverFiredAt < (h.cooldownMs || 30000)) return
    hoverFiredAt = Date.now()
    // anims 配数组就洗牌袋轮着来；老配置只写单个 anim 也兼容
    const anims = h.anims && h.anims.length ? h.anims : h.anim ? [h.anim] : ['点击回应-害羞惊讶']
    play(pickNoRepeat(anims, 'anim:hover') || anims[0], { onEnd: () => nextIdle() })
    showBubble(pickNoRepeat(h.lines, 'hover') || '盯着我干嘛呀…', null, 2600)
  }
  function armHover() {
    const h = cfg.hover || {}
    if (h.enabled === false) return
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(fireHover, h.afterMs || 1200)
  }
  function cancelHover() {
    clearTimeout(hoverTimer)
  }

  hit.addEventListener('pointerenter', armHover)
  hit.addEventListener('pointermove', armHover) // 还在动就重新计时，停住才算
  hit.addEventListener('pointerleave', cancelHover)

  // 事件挂在命中区而不是铺满窗口的 #stage 上：素材四周是空的透明像素，
  // 挂 stage 的话点空白处也能把鱼拖走
  hit.addEventListener('pointerdown', (e) => {
    cancelHover()
    dbg('pointerdown', {
      button: e.button,
      movementX: e.movementX,
      screenX: e.screenX,
      clientX: e.clientX,
      clientY: e.clientY,
    })
    if (e.button !== 0) return
    dragging = true
    downAt = performance.now()
    lastX = typeof e.screenX === 'number' ? e.screenX : null
    lastY = typeof e.screenY === 'number' ? e.screenY : null
    lastMoveAt = performance.now()
    movedDist = 0
    vel = [0, 0]
    accX = 0
    accY = 0
    try {
      hit.setPointerCapture(e.pointerId)
    } catch (err) {
      /* noop */
    }
    hideBubble()
    if (pool.drag.length) play(pool.drag[0], { loop: true })
  })

  hit.addEventListener('pointermove', (e) => {
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

  hit.addEventListener('pointerup', (e) => {
    if (!dragging) return
    dbg('pointerup', { movedDist, vel })
    dragging = false
    try {
      hit.releasePointerCapture(e.pointerId)
    } catch (err) {
      /* noop */
    }

    const dur = performance.now() - downAt
    if (movedDist < 8 && dur < 400) {
      api.dragEnd()
      poke(partAt(e.clientY))
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

  hit.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.openMenu()
  })

  // 戳它一下播哪段：以前 5 段「点击回应」纯随机，跟心情、跟你俩熟不熟完全无关。
  // 现在按顺序匹配 cfg.click.rules，命中第一条就用它的动画和台词，都没命中才随机。
  // when 支持：sulk（赌气）/ greet（久别重逢）/ bond:<档位key> / mood:<心情key>
  function clickRule() {
    const c = cfg.click || {}
    if (c.enabled === false) return null
    const lv = bondLevelNow()
    for (const r of c.rules || []) {
      if (!r || !r.anims || !r.anims.length) continue
      const w = String(r.when || '')
      let hit = false
      if (w === 'sulk') hit = !!moodSnap.sulking
      // 久别重逢：用亲密度存档里那个「上次理我」的时间戳，跨重启也记得住
      else if (w === 'greet')
        hit = !!moodSnap.lastAt && Date.now() - moodSnap.lastAt > (c.greetAfterMs || 7200000)
      else if (w.indexOf('bond:') === 0) hit = !!lv && lv.key === w.slice(5)
      else if (w.indexOf('mood:') === 0) hit = moodSnap.mood === w.slice(5)
      if (hit) return r
    }
    return null
  }

  // 落点落在命中区的哪一段：上=摸头 / 中=揉肚子 / 下=拽尾巴。
  // 用 clientY 相对命中区的位置算，窗口被拖到屏幕任何角落都对
  function partAt(clientY) {
    const p = (cfg.click || {}).parts || {}
    if (p.enabled === false) return null
    const r = hit.getBoundingClientRect()
    if (!r.height) return null
    const y = (clientY - r.top) / r.height
    const [b1, b2] = p.bands || [0.34, 0.68]
    if (y < b1) return 'head'
    if (y < b2) return 'belly'
    return 'tail'
  }

  function poke(part) {
    api.click() // 点一下出声。音效在主进程播，不经过渲染层
    api.bond('poke') // 戳一下涨一点亲密度
    const rule = clickRule()
    if (rule) {
      play(pickNoRepeat(rule.anims, 'anim:click-' + rule.when) || pickWeighted(), {
        onEnd: () => nextIdle(),
      })
      squish()
      showBubble(pickNoRepeat(rule.lines, `click:${rule.when}`) || '', null, 2600)
      return
    }
    // 分部位摸：特殊状态（赌气/久别/心情）优先在上面，普通戳才按落点分头/肚/尾。
    // 右键菜单那种没坐标的 poke() 传进来是 undefined，退回原来的兜底池
    const parts = (cfg.click || {}).parts || {}
    const one = part && parts[part]
    if (one && one.anims && one.anims.length) {
      play(pickNoRepeat(one.anims, 'anim:part-' + part) || pickWeighted(), {
        onEnd: () => nextIdle(),
      })
      squish()
      showBubble(pickNoRepeat(one.lines, `part:${part}`) || '', null, 2600)
      return
    }
    // 兜底池写在配置里：以前只有 5 段「点击回应-*」，来回来去就那几个动作。
    // 现在混进「被吓一跳 / 偷吃被抓 / 转个圈 / 吐泡泡」这类即时反应，一样走洗牌袋
    const fallback = (cfg.click || {}).fallbackAnims || pool.clicks
    play(pickNoRepeat(fallback, 'anim:click-fallback') || pickWeighted(), {
      onEnd: () => nextIdle(),
    })
    squish()
    // 混熟了就会说更亲昵的话（亲密度分级台词），没到级别就退回通用闲聊
    const lv = bondLevelNow()
    const lines = lv && lv.lines
    if (lines && lines.length && Math.random() < 0.5) {
      showBubble(pickNoRepeat(lines, `bond:${lv ? lv.key : ''}`), null, 2600)
    } else {
      showBubble(pickNoRepeat(cfg.idleTexts, 'idle-chat') || '', null, 2600)
    }
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
  // 猜拳：菜单里玩家出了手，主进程判完结果推过来。播对应动画 + 一句台词
  function onRps(d) {
    if (!d) return
    const r = cfg.rps || {}
    const branch = r[d.result] || {}
    manualUntil = Date.now() + 6000
    phase = 'idle'
    clearTimeout(phaseTimer)
    play(pickNoRepeat(branch.anims, 'anim:rps-' + d.result) || pickWeighted(), {
      onEnd: () => nextIdle(),
    })
    squish()
    const label = { win: '你赢了', lose: '你输了', draw: '平局' }[d.result] || d.result
    const line = pickNoRepeat(branch.lines, 'rps:' + d.result) || ''
    showBubble(`${label}（${d.mine} vs ${d.theirs}）· ${line}`, null, 3200)
  }
  api.on('pet:rps', onRps)
  // 递小纸条：主进程判定到点了 / 菜单手动点了，推过来一张关怀便签
  function onNote(d) {
    if (!d) return
    manualUntil = Date.now() + 7000
    phase = 'idle'
    clearTimeout(phaseTimer)
    if (d.anim) play(d.anim, { onEnd: () => nextIdle() })
    showBubble(d.line || '给你递张小纸条~', { note: d.label || true }, 7000)
  }
  api.on('pet:note', onNote)
  // 心情变了同步过来，待机链和戳它的反应都看这个
  api.on('pet:mood', (d) => {
    if (d) moodSnap = Object.assign({}, moodSnap, d)
  })
  // 三家都在摸鱼 → 它也躺平
  function onLieDown(d) {
    if (!d) return
    manualUntil = Date.now() + 9000
    clearTimeout(phaseTimer)
    hideBubble()
    phase = 'idle'
    play(d.anim || rand(pool.idle), { onEnd: () => nextIdle() })
    if (d.line) showBubble(d.line, null, 5000)
  }

  // 某一轮跑太久了 → 冒个泡提醒，不打断正在播的动画
  function onStuck(d) {
    if (!d || !d.line) return
    holdLine = d.line
    holdUntil = Date.now() + 6000
    showBubble(d.line, { source: d.source, phase: 'working', title: d.what }, 6000)
  }

  // 作息 / 拆礼物都是「播一段 + 冒一句」，只有动画名和台词不同
  function playOnce(d) {
    if (!d || !d.anim) return
    manualUntil = Date.now() + 9000
    clearTimeout(phaseTimer)
    hideBubble()
    phase = 'idle'
    play(d.anim, { onEnd: () => nextIdle() })
    if (d.line) showBubble(d.line, null, 5000)
  }

  // 冷落太久它主动来找你。跟作息/成就一样是「播一段 + 冒一句」，
  // 但气泡留久一点——它就是想让你看见
  function onLonely(d) {
    if (!d || !d.anim) return
    manualUntil = Date.now() + 9000
    clearTimeout(phaseTimer)
    hideBubble()
    phase = 'idle'
    play(d.anim, { onEnd: () => nextIdle() })
    if (d.line) showBubble(d.line, null, 6000)
  }

  // 穿透开启时鱼淡一点。不然整窗透明、鼠标也不响应，开了跟没开看不出区别
  function onClickThrough(on) {
    document.body.classList.toggle('through', !!on)
  }
  api.on('pet:clickthrough', onClickThrough)
  api.on('pet:lonely', onLonely)
  api.on('pet:liedown', onLieDown)
  api.on('pet:stuck', onStuck)
  api.on('pet:routine', playOnce)
  api.on('pet:gift', playOnce)
  // 达成成就：播大招素材（蓝鲸现世 / 凭空生花 / 动物环绕…）
  api.on('pet:achieve', playOnce)
  // 今天过什么节，主进程跨天时会重推
  api.on('pet:occasion', (d) => {
    occasion = d || null
  })
  // 每日回顾：气泡显示战报，声音在主进程念
  function onDigest(d) {
    if (!d || !d.line) return
    showBubble(d.line, null, 6000)
  }
  api.on('pet:digest', onDigest)
  api.on('pet:play', playByName)
  api.on('pet:walk-done', () => {
    manualUntil = Date.now() + 2500
    land()
  })
  api.on('pet:state', onState)
  api.on('pet:poke', poke)
  api.on('pet:landed', land)
  // 「它在干嘛？」专属响应：冒一句汇报 + 播个动作 + Q 弹。
  // 不再走 onState(force)——那样 idle 会把气泡藏掉、忙碌又显示原台词，等于没反应。
  function onSpeak(d) {
    if (!d) return
    manualUntil = Date.now() + 6000
    phase = 'idle'
    clearTimeout(phaseTimer)
    clearRotate()
    if (d.anim) play(d.anim, { onEnd: () => nextIdle() })
    squish()
    showBubble(d.line || '我在呢~', null, 5000)
  }
  api.on('pet:speak', onSpeak)
  // 聊天回答：跟 onSpeak 类似，但留久一点，气泡开头挂个"聊"标记区分状态汇报
  function onChat(d) {
    if (!d) return
    manualUntil = Date.now() + 7000
    phase = 'idle'
    clearTimeout(phaseTimer)
    clearRotate()
    if (d.anim) play(d.anim, { onEnd: () => nextIdle() })
    squish()
    showBubble(d.line || '…', null, 6500)
  }
  api.on('pet:chat', onChat)
  api.on('pet:reload-config', (payload) => {
    cfg = payload.config || cfg
    if (payload.pools) pool = payload.pools
    applyHitArea()
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
            fun: pool.fun.length,
            special: (pool.special || []).length,
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
    if (boot.mood) moodSnap = boot.mood
    if (boot.occasion) occasion = boot.occasion
    // 开机时窗口还没起来，applyClickThrough 那次 send 收不到，所以穿透状态走 boot 下发
    if (boot.clickThrough) document.body.classList.add('through')
    applyHitArea()

    // 心情相关的分支平时要等触发条件（连续失败 / 摸鱼 8 分钟 / 卡 5 分钟）才跑得到，
    // 真跑起来才发现报错就晚了。自检模式下把每条路径都走一遍，报错直接报出来。
    let probe = null
    let rotateArmed = null
    let noRepeat = null
    let bagSize = null
    let lineCounts = null
    let animNoRepeat = null
    let animPools = null
    let clickVariety = null
    let hoverVariety = null
    let revealOk = null
    let anyVisible = null
    let partProbe = null
    let noteProbe = null
    let speakProbe = null
    let chatProbe = null
    if (boot.selftest) {
      try {
        poke() // 普通戳一下（亲密度台词分支）
        const afterPoke = bubbleText.textContent
        onFeed({ food: '吃西瓜', fullness: 80, mood: 'ok', line: '好吃！' })
        onLieDown({ anim: '原地小憩沉眠', line: '陪你一起躺平…' })
        onStuck({ line: 'Cursor 这一轮跑了 6 分钟了，要不要看看', source: 'cursor', what: '大肥鱼' })
        moodSnap = Object.assign({}, moodSnap, { sulking: true, mood: 'sad' })
        poke() // 赌气时戳：应该播「傲娇生气」+ 赌气台词
        const afterSulk = bubbleText.textContent
        const animSulk = vids[active].src
        // 待机链里「过节」排在「心情」前面，先把今天的应季动作清掉才验得到心情分支；
        // 概率也强制成 1，否则 30% 的概率会让断言时灵时不灵
        occasion = null
        cfg.mood = Object.assign({}, cfg.mood, { idleChance: 1 })
        nextIdle() // 蔫的时候待机：应该播「垂头叹气冒汗」
        const sadAnim = vids[active].src
        // 作息 / 拆礼物 / 每日回顾 / 节日动作
        playOnce({ anim: '晨间刷牙', line: '早上好呀~' })
        const routineAnim = vids[active].src
        playOnce({ anim: '拆礼物', line: '攒够啦~' })
        onDigest({ line: '今天跑了 12 轮，成了 10 个' }) // 每日回顾只冒气泡
        const digestLine = bubbleText.textContent
        occasion = { name: '中秋节', anims: ['中秋赏月吃月饼'], kind: 'festival' }
        cfg.calendar = Object.assign({}, cfg.calendar, { chance: { festival: 1, season: 1 } })
        nextIdle() // 过节时待机：应该播「中秋赏月吃月饼」
        // 必须当场取：后面还有几步会接着播别的，等构造 probe 对象时 src 已经被覆盖了
        const occasionAnim = nameOf(vids[active].src)
        // 成就：播大招素材
        manualUntil = 0
        phase = 'idle'
        playOnce({ anim: '蓝鲸现世', line: '今天我也太强了吧' })
        const achieveAnim = nameOf(vids[active].src)
        // 悬停反应：跳过定时器直接触发，验证它播的是「害羞惊讶」
        manualUntil = 0
        phase = 'idle'
        hoverFiredAt = 0
        fireHover()
        const hoverAnim = nameOf(vids[active].src)
        const hoverLine = bubbleText.textContent
        // 冷落了来找你：敲桌子 / 吐泡泡。跟作息共用 playOnce 的形状，这里直接调 onLonely
        manualUntil = 0
        phase = 'idle'
        onLonely({ anim: '原地敲击桌面互动', line: '喂，理理我嘛…', bond: 40, level: '面熟' })
        const lonelyAnim = nameOf(vids[active].src)
        const lonelyLine = bubbleText.textContent
        // 戳它的反应现在按心情/亲密度走 cfg.click.rules（按顺序命中第一条）。
        // 注意 bond 档位规则排在 mood 规则前面，所以验 mood:happy 时亲密度要压低，
        // 否则会先被 bond:best 截胡
        moodSnap = Object.assign({}, moodSnap, { sulking: false, mood: 'happy', bond: 30 })
        poke()
        const happyPokeAnim = nameOf(vids[active].src) // mood:happy → 从 happy 池里抽一段
        moodSnap = Object.assign({}, moodSnap, { mood: 'calm', bond: 95 })
        poke()
        const bestPokeAnim = nameOf(vids[active].src) // bond:best → 从最亲那池里抽
        moodSnap = Object.assign({}, moodSnap, { bond: 95, lastAt: Date.now() - 3 * 3600000 })
        poke()
        const greetPokeAnim = nameOf(vids[active].src) // greet → 从久别那池里抽
        // 点击动画不再千篇一律：把 mood 压回平静、亲密度压低、刚理过它（不命中任何规则），
        // 连点一整轮，去重数应该正好等于兜底池大小——洗牌袋生效才做得到
        const fb = (cfg.click || {}).fallbackAnims || []
        moodSnap = Object.assign({}, moodSnap, {
          sulking: false,
          mood: 'calm',
          bond: 30,
          lastAt: Date.now(),
        })
        const clickSeen = new Set()
        for (let i = 0; i < fb.length; i++) {
          poke()
          clickSeen.add(nameOf(vids[active].src))
        }
        clickVariety = { pool: fb.length, unique: clickSeen.size, allUsed: clickSeen.size === fb.length }
        // 悬停反应同理：配了 anims 数组就该轮着来
        const hv = (cfg.hover || {}).anims || []
        // 抽两轮：袋子可能已被前面的 probe 消耗过，只抽一轮会跨轮次边界撞上重复
        const hoverSeen = new Set()
        for (let i = 0; i < hv.length * 2; i++) {
          hoverFiredAt = 0
          phase = 'idle'
          manualUntil = 0
          fireHover()
          hoverSeen.add(nameOf(vids[active].src))
        }
        hoverVariety = { pool: hv.length, unique: hoverSeen.size, allUsed: hoverSeen.size === hv.length }
        // 工作档位现在每档可以多段轮换，验证 working 真的配了不止一段
        const phaseCounts = {}
        for (const k of Object.keys(pool.phase)) phaseCounts[k] = pool.phase[k].length
        // 档位内轮换：连播几次要能看到不只一种（否则等于没配）
        manualUntil = 0
        phase = 'working'
        const rotSeen = new Set()
        for (let i = 0; i < 40; i++) {
          playPhase('working')
          rotSeen.add(nameOf(vids[active].src))
        }
        const rotated = rotSeen.size
        // 轮换定时器必须活得过同档位的后续推送——状态每秒推一次，
        // 之前 onState 开头无条件 clearTimeout，把它冲掉了
        manualUntil = 0
        onState({ phase: 'working', force: true })
        const armed1 = !!rotateTimer
        onState({ phase: 'working' }) // 第二次同档位推送
        const armed2 = !!rotateTimer
        onState({ phase: 'idle', force: true }) // 回 idle 要清掉
        const armedIdle = !!rotateTimer
        rotateArmed = armed1 === true && armed2 === true && armedIdle === false
        // 文案：洗牌袋要保证「一轮之内不重复」。抽满一整轮的条数，
        // 去重后应该正好等于总数——纯随机的话这里会明显少
        const bag = []
        for (let i = 0; i < cfg.idleTexts.length; i++) bag.push(pickNoRepeat(cfg.idleTexts, 'probe-bag'))
        const bagUnique = new Set(bag).size
        noRepeat = bagUnique === cfg.idleTexts.length
        // 顺带统计各段文案条数，方便一眼看出哪一块还是太单薄
        const countOf = (x) =>
          Array.isArray(x)
            ? x.reduce((s, v) => s + countOf(v), 0)
            : x && typeof x === 'object'
              ? Object.values(x).reduce((s, v) => s + countOf(v), 0)
              : typeof x === 'string' && x.trim()
                ? 1
                : 0
        lineCounts = {
          idle: (cfg.idleTexts || []).length,
          texts: countOf(cfg.texts),
          bySource: countOf(cfg.textsBySource),
          bond: countOf((cfg.bond || {}).levels || []),
          hover: (cfg.hover || {}).lines ? (cfg.hover.lines || []).length : 0,
          lonely: (cfg.lonely || {}).lines ? (cfg.lonely.lines || []).length : 0,
        }
        bagSize = bagUnique
        // 动画同理：连抽一整轮趣味素材，去重后应该正好等于总数
        const abag = []
        for (let i = 0; i < pool.fun.length; i++) abag.push(pickNoRepeat(pool.fun, 'probe-anim'))
        animNoRepeat = new Set(abag).size === pool.fun.length
        animPools = {
          idle: pool.idle.length,
          turn: pool.turn.length,
          move: pool.move.length,
          whisper: pool.whisper.length,
          fun: pool.fun.length,
          special: (pool.special || []).length,
        }
        // 鼠标穿透：开了之后鱼要变淡，否则肉眼看不出开关有没有生效
        onClickThrough(true)
        const throughOn = document.body.classList.contains('through')
        onClickThrough(false)
        const throughOff = document.body.classList.contains('through')
        // 命中区：stage 不收鼠标，只有 hit 收，且 hit 必须明显小于整个窗口
        applyHitArea()
        // 气泡位置：底边要压在头顶上方一点点（gap 配的是 6px，量出来应该在 0~16px 内）。
        // 写死 top 的话这里会变成 70+，一眼就能看出气泡飘走了
        // 先关掉入场动画，不然量到的是 translateY(6px) 那个还没落位的中间态
        const savedTransition = bubble.style.transition
        bubble.style.transition = 'none'
        showBubble('自检：气泡贴头顶', {}, 0)
        const br = bubble.getBoundingClientRect()
        const bubbleGap = Math.round(headTopPx() - br.bottom)
        hideBubble()
        bubble.style.transition = savedTransition
        // 播放切换：新逻辑要等 loadeddata 才把 show 挪到新视频，旧画面在此之前一直留着。
        // 自检是同步的，事件不会自己来，这里手动派发一次验证 show 收口在 active 上
        manualUntil = 0
        phase = 'idle'
        play('待机呼吸休闲', { onEnd: () => {} })
        const targetVid = vids[active]
        const otherVid = vids[1 - active]
        targetVid.dispatchEvent(new Event('loadeddata'))
        revealOk =
          targetVid.classList.contains('show') && !otherVid.classList.contains('show')
        anyVisible = vids.some((v) => v.classList.contains('show'))
        // 分部位摸：命中区分三段，各段落点要判断对，且播的是该部位配的动画。
        // 心情压到 calm、亲密度压低、刚理过它（不触发 clickRule 的任何规则）
        const pr = hit.getBoundingClientRect()
        const partsCfg = (cfg.click || {}).parts || {}
        const seen = {}
        const bandOk = {}
        for (const key of ['head', 'belly', 'tail']) {
          const frac = key === 'head' ? 0.15 : key === 'belly' ? 0.5 : 0.9
          const p = partAt(pr.top + pr.height * frac)
          bandOk[key] = p === key
          moodSnap = Object.assign({}, moodSnap, {
            sulking: false,
            mood: 'calm',
            bond: 30,
            lastAt: Date.now(),
          })
          poke(p)
          seen[key] = {
            anim: nameOf(vids[active].src),
            inPool: ((partsCfg[key] || {}).anims || []).includes(nameOf(vids[active].src)),
            line: bubbleText.textContent,
          }
        }
        partProbe = { bandOk, seen }
        // 递小纸条：强制推一张，验证便签 class / 标签 / 台词都到位
        onNote({ line: '自检便签', anim: null, label: '小纸条' })
        noteProbe = {
          noteClass: bubble.classList.contains('note'),
          tag: noteTag.textContent,
          line: bubbleText.textContent,
        }
        hideBubble() // 自检跑完把便签样式收掉
        // 「它在干嘛？」：强制推一句汇报，验证气泡确实显示、且是汇报文本、没误带便签样式
        onSpeak({ line: '自检汇报', anim: null, phase: 'idle' })
        speakProbe = {
          shown: bubble.classList.contains('show'),
          line: bubbleText.textContent,
          notNote: !bubble.classList.contains('note'),
        }
        hideBubble()
        // 聊天：强制推一句回答，验证气泡显示正确文本
        onChat({ line: '自检聊天回答', anim: null, online: false })
        chatProbe = {
          shown: bubble.classList.contains('show'),
          line: bubbleText.textContent,
        }
        hideBubble()
        const hr = hit.getBoundingClientRect()
        const hitInfo = {
          stage: getComputedStyle(stage).pointerEvents,
          hit: getComputedStyle(hit).pointerEvents,
          w: Math.round(hr.width),
          h: Math.round(hr.height),
          winW: window.innerWidth,
          winH: window.innerHeight,
        }
        probe = {
          poke: afterPoke,
          sulkLine: afterSulk,
          sulkAnim: nameOf(animSulk),
          sadAnim: nameOf(sadAnim),
          routineAnim: nameOf(routineAnim),
          digestLine,
          occasionAnim,
          through: throughOn === true && throughOff === false,
          hit: hitInfo,
          bubble: { gap: bubbleGap, bottom: Math.round(br.bottom), headTop: Math.round(headTopPx()) },
          achieveAnim,
          hoverAnim,
          hoverLine,
          lonelyAnim,
          lonelyLine,
          happyPokeAnim,
          bestPokeAnim,
          greetPokeAnim,
          phaseCounts,
          rotated,
          rotateArmed,
          noRepeat,
          bagSize,
          lineCounts,
          animNoRepeat,
          animPools,
          clickVariety,
          hoverVariety,
          reveal: { revealOk, anyVisible },
          parts: partProbe,
          note: noteProbe,
          speak: speakProbe,
          chat: chatProbe,
        }
      } catch (e) {
        probe = { error: String((e && e.message) || e) }
      }
      // probe 里为了看效果改了心情和节日，跑完恢复成开机时的真实值
      if (boot.mood) moodSnap = boot.mood
      occasion = boot.occasion || null
      phase = 'idle'
      hideBubble()
    }

    const first = rand(pool.idle) || rand(pool.fun) || (boot.assets || [])[0]
    play(first, {})
    const v = vids[active]
    v.addEventListener('playing', () => selftestReport(boot, { playing: true, probe }), { once: true })
    v.addEventListener('error', () => selftestReport(boot, { playing: false, err: 'media error', probe }), {
      once: true,
    })
    setTimeout(() => selftestReport(boot, { note: 'fallback-timeout', probe }), 12000)
  })
})()
