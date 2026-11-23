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
  const bubbleImg = document.getElementById('bubble-img')
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
  let sleeping = false // 睡觉玩法：睡着时戳它只"嘘"一声，不打断美梦
  let sleepLine = '' // 睡觉时气泡里挂的那句"别吵"
  let bubbleImgTimer = null // 梗图配图的独立定时，避免被文字气泡刷新冲掉
  let bubbleImgVisible = false // 当前是否有配图在显示（扩窗状态跟着它走）

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
  // 当前真正在显示（.show）的那条 video 的索引。-1 表示两条都没画面（刚启动/异常）。
  // 关键：active 是「逻辑指针」，每次 play 立刻 +1；但 show 要等解码好才切。二者在
  // 快速切换/报错/兜底 advance 时会脱节。选下一条 video 必须以「实际 show」为准——
  // 永远拿没在显示的那条当 next，否则一旦 active 与 show 脱节，就会挑中正显示的那条
  // 改它的 src → 当前画面瞬间清空、新画面还没解码 → 两条都不可见 → 只剩气泡、鱼消失。
  function shownIndex() {
    return vids.findIndex((v) => v.classList.contains('show'))
  }

  function play(name, opts) {
    if (!name) return
    opts = opts || {}
    const cur = shownIndex()
    // 以实际显示的画面为准选 next：CC 里若 cur=-1（两条都没 show），退回 active 的反面
    const nextIdx = cur < 0 ? 1 - active : 1 - cur
    const next = vids[nextIdx]
    const my = ++token
    let shown = false
    let advanced = false
    let guard = null

    const reveal = () => {
      if (my !== token || shown) return
      shown = true
      if (guard) clearTimeout(guard)
      // 统一收口到本次的 nextIdx：即便期间又冒出别的 play，也只认自己那条，绝不把
      // show 留在尚未解码好的元素上。用 nextIdx 而非 active——active 可能被后续 play 改掉。
      vids.forEach((v, i) => v.classList.toggle('show', i === nextIdx))
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

    // 逻辑指针同步到本次实际选用的那条：自检靠 vids[active].src 同步读播了哪段。
    // 用 nextIdx 而非 1-active，保证 active 与 reveal 的收口目标、与实际 src 三者一致
    active = nextIdx

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
    // 配图（梗图 / 通知图）：s.img 是 pet:// URL。图片自身带独立定时，
    // 文字气泡每 0.5~1s 会被状态推送刷一次，配图不能跟着闪。
    if (bubbleImg) {
      clearTimeout(bubbleImgTimer)
      if (s.img) {
        if (!bubbleImgVisible) api.picOpen() // 首次出图才扩窗，连续刷新不重复
        bubbleImgVisible = true
        bubbleImg.src = s.img
        bubbleImg.style.display = 'block'
        bubbleImg.onerror = () => {
          bubbleImg.style.display = 'none'
          if (bubbleImgVisible) { bubbleImgVisible = false; api.picClose() } // 图裂了恢复窗口
        }
        bubbleImgTimer = setTimeout(() => {
          bubbleImg.style.display = 'none'
          if (bubbleImgVisible) { bubbleImgVisible = false; api.picClose() }
        }, s.imgMs || ms || 4000)
      } else if (bubbleImgVisible) {
        bubbleImg.style.display = 'none'
        bubbleImg.removeAttribute('src')
        bubbleImgVisible = false
        api.picClose()
      }
    }
    // 便签样式是"一次性"的：这次显示完（含被下一次普通气泡打断）就恢复成普通气泡
    bubble.classList.toggle('note', !!s.note)
    bubble.classList.toggle('evolve', !!s.evolve)
    if (s.note) noteTag.textContent = s.note === true ? '小纸条' : s.note
    bubble.classList.add('show')
    if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms)
  }

  function hideBubble() {
    clearTimeout(bubbleTimer)
    bubble.classList.remove('show')
    bubble.classList.remove('note')
    bubble.classList.remove('evolve')
    if (bubbleImg) {
      clearTimeout(bubbleImgTimer)
      bubbleImg.style.display = 'none'
      bubbleImg.removeAttribute('src')
      if (bubbleImgVisible) { bubbleImgVisible = false; api.picClose() }
    }
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
    // 弹弓模式：拖拽改为「拉皮筋蓄力」，不移动窗口；松手弹射由 SlingshotGame 处理
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      // 必须捕获指针：鱼命中区很小，往后拉时鼠标会移出这个透明小窗口，
      // 不捕获的话 pointermove/up 会丢、松手那一下还会点到下面的其它软件。
      try {
        hit.setPointerCapture(e.pointerId)
      } catch (err) {
        /* noop */
      }
      window.SlingshotGame.beginDrag(e)
      return
    }
    dragging = true
    document.body.classList.add('dragging')
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
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      window.SlingshotGame.moveDrag(e)
      return
    }
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
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      try {
        hit.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* noop */
      }
      const shot = window.SlingshotGame.releaseDrag()
      if (shot) api.throw(shot.vx, shot.vy)
      return
    }
    if (!dragging) return
    dbg('pointerup', { movedDist, vel })
    dragging = false
    document.body.classList.remove('dragging')
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

  hit.addEventListener('pointercancel', (e) => {
    dragging = false
    document.body.classList.remove('dragging')
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      try {
        hit.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* noop */
      }
      const shot = window.SlingshotGame.releaseDrag()
      if (shot) api.throw(shot.vx, shot.vy)
    }
  })

  hit.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    toggleActionMenu()
  })

  // ===== 自绘气泡菜单 =====
  // 两页：主页面 8 个高频项；「更多 ›」翻到子页，状态/设置/打开/退出全在里面，
  // 全程不弹原生菜单。打开时主进程把窗口向上扩，鱼贴底不动，菜单长在头顶空白里。
  const actionMenu = document.getElementById('action-menu')
  const actionMenuItems = document.getElementById('action-menu-items')
  const actionMenuTitle = actionMenu.querySelector('.action-menu-title')
  let menuOpen = false
  let menuPage = 'main' // 'main' | 'more'（分组宫格目录）| 'group'（组内宫格）
  // 动作库复用 more/group 两套渲染，只靠 groupBackSource 区分数据源与返回目标
  let moreGroups = [] // 缓存更多页分组数据
  let animLibGroups = [] // 缓存动作库分类数据
  let groupBackSource = 'more' // 当前组内页从哪个目录进来：'more' | 'animlib'

  // 主页面动作清单。每项自带 icon（emoji）+ 主题色（ico/tint），特殊动作 __more__/__back__ 只翻页。
  function actionList() {
    const c = cfg || {}
    const list = [
      { action: 'chat', ico: '💬', tint: '#378add', txt: '聊聊天', hint: '打开对话', enabled: true },
      { action: 'poke', ico: '🤚', tint: '#e0679a', txt: '摸一下', hint: '', enabled: true },
      { action: 'rps', ico: '✊', tint: '#e08a3c', txt: '猜个拳', hint: '石头剪刀布', enabled: (c.rps || {}).enabled !== false },
      { action: 'note', ico: '📝', tint: '#b8860b', txt: '递纸条', hint: '', enabled: (c.note || {}).enabled !== false },
      { action: 'feed', ico: '🍚', tint: '#4c9e6a', txt: '喂一口', hint: '偶尔有惊喜', enabled: c.feed && c.feed.enabled !== false },
      { action: 'speak', ico: '💭', tint: '#7b6cd4', txt: '在干嘛', hint: '', enabled: true },
      {
        action: 'crawl',
        ico: '🐾',
        tint: '#2a9d8f',
        txt: document.body.classList.contains('crawling') ? '停巡游' : '桌面巡游',
        hint: '',
        enabled: (c.crawler || {}).enabled !== false,
      },
      {
        action: 'game',
        ico: '🎯',
        tint: '#e0679a',
        txt: document.body.classList.contains('slingshot-mode') ? '结束弹弓' : '玩弹弓',
        hint: document.body.classList.contains('slingshot-mode') ? '退出发射器' : '弹射我自己',
        enabled: true,
      },
      // 新素材玩法，放第一屏显眼位置，不再藏进三级菜单
      {
        action: 'sleep',
        ico: sleeping ? '🌅' : '😴',
        tint: '#7b6cd4',
        txt: sleeping ? '叫醒它' : '哄睡觉',
        hint: '',
        enabled: true,
      },
      { action: 'meme', ico: '🖼️', tint: '#e0679a', txt: '斗张图', hint: '', enabled: true },
      { action: '__more__', ico: '⚙️', tint: '#7d8a99', txt: '更多', hint: '状态 / 设置 / 退出', enabled: true },
    ]
    return list.filter((x) => x.enabled)
  }

  // 把主题色挂到按钮容器上：--tint 主色（hover/边框），--tint-bg 与白混合的浅底。
  // 自己算浅色而不依赖 color-mix，兼容旧版 Chromium；CSS 变量会继承到子图标。
  function softTint(hex, whiteRatio) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return ''
    const n = parseInt(m[1], 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const b = n & 255
    const mix = (c) => Math.round(c * (1 - whiteRatio) + 255 * whiteRatio)
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
  }
  function applyTint(el, tint) {
    if (!tint) return
    el.style.setProperty('--tint', tint)
    el.style.setProperty('--tint-bg', softTint(tint, 0.86))
  }

  // 造一个气泡按钮。点击：翻页动作切页；普通动作收起菜单并分发；readonly 不可点。
  // compact=true 用于宫格主页面：不显示 hint，靠 CSS 把图标放上、文字放下。
  function makeItem(it, i, compact) {
    if (it.readonly) {
      const row = document.createElement('div')
      row.className = 'action-item action-item-info'
      row.setAttribute('role', 'menuitem')
      applyTint(row, it.tint)
      const ico = document.createElement('span')
      ico.className = 'ico'
      ico.textContent = it.ico
      const txt = document.createElement('span')
      txt.className = 'txt'
      txt.textContent = it.txt
      row.appendChild(ico)
      row.appendChild(txt)
      return row
    }
    const btn = document.createElement('button')
    btn.className = 'action-item' + (it.danger ? ' action-item-danger' : '')
    btn.type = 'button'
    btn.setAttribute('role', 'menuitem')
    btn.dataset.action = it.action || ''
    btn.style.setProperty('--i', i)
    applyTint(btn, it.tint)
    const ico = document.createElement('span')
    ico.className = 'ico'
    ico.textContent = it.ico
    const txt = document.createElement('span')
    txt.className = 'txt'
    txt.textContent = it.txt
    btn.appendChild(ico)
    btn.appendChild(txt)
    if (it.hint && !compact) {
      const hint = document.createElement('span')
      hint.className = 'hint'
      hint.textContent = it.hint
      btn.appendChild(hint)
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (it.action === '__more__') {
        showMorePage()
        return
      }
      if (it.action === 'animLib') {
        showAnimLibPage()
        return
      }
      if (it.action === '__back__') {
        showMainPage()
        return
      }
      if (it.action === '__more-back__') {
        // 组内页返回：从动作库进来的回动作库目录，否则回更多页目录
        if (groupBackSource === 'animlib') showAnimLibIndex()
        else showMoreIndex()
        return
      }
      if (it.action === '__animlib-back__') {
        // 动作库目录页返回 → 回更多页目录
        showMoreIndex()
        return
      }
      closeActionMenu()
      // 动作库的点播项：动画名在本地直接播，不必绕主进程 IPC（playByName 就在本文件里）
      if (it.anim && typeof playByName === 'function') playByName(it.anim)
      else api.action(it.action)
    })
    return btn
  }

  function showMainPage() {
    menuPage = 'main'
    actionMenu.classList.remove('page-more', 'page-more-group')
    actionMenu.classList.add('page-main')
    actionMenuTitle.textContent = '想让我做什么？'
    actionMenuItems.innerHTML = ''
    actionList().forEach((it, i) => actionMenuItems.appendChild(makeItem(it, i, true)))
  }

  // 目录页：把每个分组做成一个彩色宫格块，和主菜单同一套视觉。
  // 更多页与动作库共用这一套渲染，靠 source 切换数据源 / 标题 / 返回动作。
  // 点某块进入 renderGroupPage 看该组内容；自检可直接喂假数据验证。
  function renderMoreIndex(groups, source) {
    const sc = source === 'animlib' ? 'animlib' : 'more'
    if (sc === 'animlib') animLibGroups = groups || []
    else moreGroups = groups || []
    groupBackSource = sc
    menuPage = 'more'
    actionMenu.classList.remove('page-main', 'page-more-group')
    actionMenu.classList.add('page-more')
    actionMenuTitle.textContent = sc === 'animlib' ? '🎬 动作库' : '更多设置'
    actionMenuItems.innerHTML = ''
    // 动作库目录返回回更多页；更多页目录返回回主页面
    const backAction = sc === 'animlib' ? '__animlib-back__' : '__back__'
    actionMenuItems.appendChild(makeItem({ action: backAction, ico: '‹', txt: '返回', hint: '' }, 0))
    ;(groups || []).forEach((g, gi) => {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'action-item group-tile'
      tile.style.setProperty('--i', gi + 1)
      applyTint(tile, g.tint)
      tile.setAttribute('role', 'menuitem')
      const ico = document.createElement('span')
      ico.className = 'ico'
      ico.textContent = g.icon || '•'
      const txt = document.createElement('span')
      txt.className = 'txt'
      txt.textContent = g.title || '其他'
      tile.appendChild(ico)
      tile.appendChild(txt)
      tile.addEventListener('click', (ev) => {
        ev.stopPropagation()
        // 带 jump 的块直接跳目标页，不再进只有单个按钮的"组内页"那一级
        if (g.jump === 'animlib') {
          showAnimLibPage()
          return
        }
        renderGroupPage(gi, sc)
      })
      actionMenuItems.appendChild(tile)
    })
  }

  // 组内页：某个分组的具体项目，宫格排布。纯只读组用 2 列，其余 4 列。
  function renderGroupPage(gi, source) {
    const list = source === 'animlib' ? animLibGroups : moreGroups
    const g = list[gi]
    if (!g) return
    groupBackSource = source === 'animlib' ? 'animlib' : 'more'
    menuPage = 'group'
    actionMenu.classList.remove('page-main')
    actionMenu.classList.add('page-more', 'page-more-group')
    actionMenuTitle.textContent = g.title || '更多'
    actionMenuItems.innerHTML = ''
    actionMenuItems.appendChild(makeItem({ action: '__more-back__', ico: '‹', txt: '返回', hint: '' }, 0))
    const infoGrid = (g.items || []).length > 0 && g.items.every((it) => it.readonly)
    // 必须包在 .action-group.expanded 里：.action-group-body 默认 max-height:0/opacity:0，
    // 少了这层容器内容会渲染但不可见（点进去像"没有下一级"）。
    const wrap = document.createElement('div')
    wrap.className = 'action-group expanded'
    const body = document.createElement('div')
    body.className = 'action-group-body grp-grid' + (infoGrid ? ' grp-info' : '')
    ;(g.items || []).forEach((it, ii) => body.appendChild(makeItem(it, ii, true)))
    wrap.appendChild(body)
    actionMenuItems.appendChild(wrap)
  }

  // 从主菜单进入更多目录（异步取数据）；屏蔽 awaiting 期间已翻页/关闭的情况
  async function showMorePage() {
    menuPage = 'more'
    actionMenuTitle.textContent = '更多设置'
    let groups = []
    try {
      groups = (await api.menuData()) || []
    } catch (e) {
      groups = []
    }
    if (menuPage !== 'more') return
    renderMoreIndex(groups)
  }

  // 已拿到数据时直接显示目录（组内点返回用，免得再异步取一次）
  function showMoreIndex() {
    renderMoreIndex(moreGroups)
  }

  // 动作库：从「更多」页点入口进入，异步取 11 个动画分类；沿用目录宫格渲染。
  // 菜单太乱的元凶就是过去把这 11 组平铺进更多页，现在它们独占这一页。
  async function showAnimLibPage() {
    menuPage = 'more'
    actionMenuTitle.textContent = '🎬 动作库'
    let groups = []
    try {
      groups = (await api.animLibData()) || []
    } catch (e) {
      groups = []
    }
    if (menuPage !== 'more') return
    renderMoreIndex(groups, 'animlib')
  }

  // 动作库组内点返回 → 回到动作库分类目录（用缓存，不再异步取）
  function showAnimLibIndex() {
    renderMoreIndex(animLibGroups, 'animlib')
  }

  function renderActionMenu() {
    if (menuPage === 'group') {
      if (groupBackSource === 'animlib') showAnimLibIndex()
      else showMoreIndex()
    } else if (menuPage === 'more') {
      if (groupBackSource === 'animlib') showAnimLibPage()
      else showMorePage()
    } else showMainPage()
  }

  function openActionMenu() {
    if (menuOpen) return
    menuOpen = true
    hideBubble()
    actionMenuItems.innerHTML = '' // 清掉上一次的（自检可能留过）
    showMainPage()
    document.body.classList.add('menu-open')
    actionMenu.classList.add('show')
    api.menuOpen()
  }

  function closeActionMenu() {
    if (!menuOpen) return
    menuOpen = false
    actionMenu.classList.remove('show')
    document.body.classList.remove('menu-open')
    api.menuClose()
  }

  function toggleActionMenu() {
    if (menuOpen) closeActionMenu()
    else openActionMenu()
  }

  // 点菜单外收起：菜单打开时铺了全屏透明遮罩（#menu-scrim），
  // 它盖住鱼身和窗口空白，左键点哪都能收到 → 关菜单。
  const menuScrim = document.getElementById('menu-scrim')
  if (menuScrim) {
    menuScrim.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return // 右键交给下面的 contextmenu
      closeActionMenu()
    })
    // 菜单开着时右键任意位置也收起（此时遮罩盖住 #hit，hit 的 contextmenu 收不到）
    menuScrim.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      closeActionMenu()
    })
  }
  // window 兜底：点菜单里任何"非按钮"区域都要能关——宫格间隙、标题栏、items 容器空白
  // 都属于 pointer-events:auto 的 .action-menu-items，会挡住下面的遮罩，
  // 用 contains 判断会漏掉这些（之前点空白关不掉就是这个原因）。
  // 只有真正点在实际按钮（.action-item / .group-tile）上才不关，交给按钮自己的 click。
  window.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return
    if (menuOpen && !e.target.closest('.action-item, .group-tile')) closeActionMenu()
  })
  window.addEventListener('keydown', (e) => {
    if (menuOpen && e.key === 'Escape') closeActionMenu()
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
    // 睡觉玩法：睡着时戳它只会"嘘"一声，不打断美梦。要醒得走菜单的"叫醒它"或直接拖它
    if (sleeping) {
      showBubble('嘘…让它睡会儿 Zzz', { img: 'pet://pic/sleep-zzz.png', imgMs: 2200 }, 2200)
      return
    }
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
    // 弹弓模式：真窗落地后重新架好弹弓（收起飞行态、鱼位复位）
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) window.SlingshotGame.onLanded()
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
    if (d.show === 'feast') {
      onFeast(d)
      return
    }
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

  // ---- 睡觉玩法：躺下 → 循环 → 起来，三段串起来播 ----
  let sleepTimers = []
  function clearSleepTimers() {
    sleepTimers.forEach(clearTimeout)
    sleepTimers = []
  }
  function onSleep(d) {
    if (!d || !d.start) return
    clearSleepTimers()
    sleeping = true
    sleepLine = (d.lines && d.lines[0]) || 'Zzz…'
    manualUntil = Date.now() + 60000 // 睡觉期间长时间屏蔽状态机
    clearTimeout(phaseTimer)
    clearRotate()
    hideBubble()
    phase = 'idle'
    document.body.classList.add('sleeping')
    // 躺下 → 循环打呼 → 起来。注意 loop:true 的素材不会触发 onended，
    // 所以循环段播多久完全由定时器决定：进循环后挂一个 9 秒的唤醒定时器。
    play(d.start, {
      onEnd: () => {
        if (!sleeping) return
        play(d.loop, { loop: true }) // 无缝循环段，一直打呼
        showBubble(sleepLine, { img: 'pet://pic/sleep-zzz.png', imgMs: 9000 }, 0)
        sleepTimers.push(setTimeout(() => doWakeAnim(d), 9000)) // 打呼约 9 秒后自己醒
      },
    })
    sleepTimers.push(setTimeout(() => doWakeAnim(d), 20000)) // 兜底：最多睡 20 秒，防 onEnd 不来卡死
  }
  function doWakeAnim(d) {
    if (!sleeping) return
    clearSleepTimers()
    sleeping = false
    sleepLine = ''
    document.body.classList.remove('sleeping')
    play((d && d.end) || '睡觉-起来', { onEnd: () => nextIdle() })
    showBubble((d && d.wakeLine) || '唔…睡饱啦~', null, 3000)
    manualUntil = Date.now() + 6000
  }
  function onWake() {
    if (sleeping) doWakeAnim({ end: '睡觉-起来' })
  }
  api.on('pet:sleep', onSleep)
  api.on('pet:wake', onWake)

  // 白饭演出：开心小跑(跑到底部) → 期待开饭 → 吃到碗饭/吃饭团，配碗图
  function onFeast(d) {
    if (!d) return
    fullness = d.fullness
    clearSleepTimers()
    manualUntil = Date.now() + 16000
    clearTimeout(phaseTimer)
    hideBubble()
    phase = 'idle'
    const eat = Math.random() < 0.5 ? '吃饭·碗饭' : '吃饭团'
    play('开心小跑', {
      onEnd: () =>
        play('期待开饭', {
          onEnd: () =>
            play(eat, {
              onEnd: () => {
                hideBubble()
                nextIdle()
              },
            }),
        }),
    })
    showBubble(d.line || '开饭啦！', { img: 'pet://pic/baifan/bowl-full.png', imgMs: 4200 }, 0)
  }

  // 梗图：气泡配一张随机表情包 + 一句话
  function onMeme(d) {
    if (!d || !d.url) return
    manualUntil = Date.now() + 5000
    phase = 'idle'
    clearTimeout(phaseTimer)
    hideBubble()
    showBubble(d.line || '看这个~', { img: d.url, imgMs: 5000 }, 5000)
  }
  api.on('pet:meme', onMeme)

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
  // 羁绊进化：亲密度跨档时播变身演出。气泡挂个 evolve 标记做金色描边，
  // 跟普通汇报、小纸条区分开，让「升级」这件事有仪式感。
  function onEvolve(d) {
    if (!d) return
    manualUntil = Date.now() + 9000
    phase = 'idle'
    clearTimeout(phaseTimer)
    clearRotate()
    if (d.anim) play(d.anim, { onEnd: () => nextIdle() })
    squish()
    const perk = d.perkText ? ' · ' + d.perkText : ''
    showBubble(`${d.formLabel || '新形态'}！${d.line || ''}${perk}`, { evolve: true }, 8000)
  }
  api.on('pet:evolve', onEvolve)
  // 桌面巡游：主进程在「开始/停下/换行为/转身」时推，不会每帧打扰渲染层。
  // 消息带 activity（walk/run/look/stretch/shy/greet/flee）和 dir（窗口移动方向 1/-1）。
  // 鱼始终在屏幕底边，没有倒挂/翻转（用户明确不要）。
  //
  // 移动方式：窗口真的沿桌面底边平移（鱼在大范围溜达、气泡跟着窗口=跟着鱼），
  // 素材只负责"朝对方向迈步"——往左移播朝左的走路素材、往右移播镜像的朝右素材，
  // 脚步方向和位移方向一致，消除过去"踩着隐形滑板平移"的诡异感。
  let crawlKey = ''
  let crawlDir = 0
  let crawlPrevKeyForLine = ''
  function onCrawl(d) {
    if (!d) return
    document.body.classList.toggle('crawling', d.active !== false)
    if (d.active === false) {
      crawlKey = ''
      crawlDir = 0
      crawlPrevKeyForLine = ''
      manualUntil = 0
      hideBubble() // 收掉巡游台词，别停在半空
      return
    }
    const key = d.activity || 'walk'
    const dir = d.dir === -1 ? -1 : 1
    const changed = key !== crawlKey || dir !== crawlDir
    crawlKey = key
    crawlDir = dir
    manualUntil = Date.now() + 60000
    phase = 'idle'
    clearTimeout(phaseTimer)
    clearRotate()
    const c = cfg.crawler || {}
    const one = ((c.activities || {})[key]) || {}
    const isTravel = (c.travelActivities || ['walk', 'run', 'flee']).indexOf(key) >= 0
    // 移动类行为：按窗口方向选走路素材（dir<0 朝左用原图，dir>0 朝右用镜像），
    // 让脚步和真实位移方向一致。驻足类行为才按池抽各自动画。
    const travel = dir < 0 ? (c.travelLeft || '巡游走路-左') : (c.travelRight || '巡游走路-右')
    const anim = isTravel ? travel : pickNoRepeat(one.anims, 'anim:crawl-' + key)
    // 一律 loop：短反应到期后主进程会推 walk 覆盖，不会停在末帧；
    // loop 也避免 unknown 动画卡住播放链（巡游期间没有 onEnd 兜底链）。
    // 仅在实际需要换片时才 play，避免同一段被重复 play 导致每帧从头重播。
    if (changed || !(vids[shownIndex()] && nameOf(vids[shownIndex()].src) === anim)) {
      play(anim || travel || '巡游走路-左', { loop: true })
    }
    if (key !== crawlPrevKeyForLine) {
      const line = pickNoRepeat(one.lines, 'line:crawl-' + key) || '我自己溜达会儿~'
      // 气泡常驻到下次行为切换，行为一换就换台词（单纯转身不换台词）
      showBubble(line, null, 0)
      crawlPrevKeyForLine = key
    }
  }
  api.on('pet:crawl', onCrawl)
  api.on('pet:reload-config', (payload) => {
    cfg = payload.config || cfg
    if (payload.pools) pool = payload.pools
    applyHitArea()
    hideBubble()
    phase = 'idle'
    nextIdle()
  })
  // 主进程分发「玩弹弓」动作后发来：进入/退出弹弓发射器模式（toggle）。
  // 弹射的是这只真桌宠窗口本身——不扩窗、不隐藏鱼，只叠一根弹弓 HUD。
  api.on('pet:open-game', (d) => {
    if (!window.SlingshotGame) return
    try {
      closeActionMenu()
      const on = !d || d.on !== false
      if (on) window.SlingshotGame.enter()
      else window.SlingshotGame.close()
    } catch (e) {
      console.error('[pet] 切换弹弓模式失败：', e)
    }
  })
  // 弹弓命中目标 / 全清：转给 SlingshotGame 播音效和提示
  api.on('pet:target-hit', () => {
    if (window.SlingshotGame && window.SlingshotGame.onTargetHit) window.SlingshotGame.onTargetHit()
  })
  api.on('pet:armor-hit', () => {
    if (window.SlingshotGame && window.SlingshotGame.onArmorHit) window.SlingshotGame.onArmorHit()
  })
  api.on('sg:clear', () => {
    if (window.SlingshotGame && window.SlingshotGame.onClear) window.SlingshotGame.onClear()
  })
  // 关卡信息（关卡号/弹药/得分）同步到桌宠 HUD
  api.on('sg:level', (d) => {
    if (window.SlingshotGame && window.SlingshotGame.onLevel) window.SlingshotGame.onLevel(d)
  })
  api.on('sg:fail', (d) => {
    if (window.SlingshotGame && window.SlingshotGame.onFail) window.SlingshotGame.onFail(d)
  })
  api.on('sg:respawn', () => {
    if (window.SlingshotGame && window.SlingshotGame.onRespawn) window.SlingshotGame.onRespawn()
  })
  // 全屏输入屏障接手的拖拽：坐标已换算成鱼窗口内，转给弹弓逻辑。
  // 用屏障层接管是为了鼠标移出鱼窗口后事件不丢失、也不误触下层应用。
  api.on('pet:barrier-down', (d) => {
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      window.SlingshotGame.beginDrag({ clientX: d.x, clientY: d.y })
    }
  })
  api.on('pet:barrier-move', (d) => {
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      window.SlingshotGame.moveDrag({ clientX: d.x, clientY: d.y })
    }
  })
  api.on('pet:barrier-up', (d) => {
    if (window.SlingshotGame && window.SlingshotGame.isOpen()) {
      const shot = window.SlingshotGame.releaseDrag()
      if (shot && api.throw) api.throw(shot.vx, shot.vy)
    }
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
    let noVanish = null
    let partProbe = null
    let noteProbe = null
    let speakProbe = null
    let chatProbe = null
    let evolveProbe = null
    let crawlProbe = null
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
        // 竞态回归：制造「active 与 show 脱节」——让当前画面在 v0，但把 active 指向 v1。
        // 旧逻辑 next=vids[1-active]=v0 会改掉正显示那条的 src → 画面清空；
        // 新逻辑以 show 为准 next=vids[1]，正显示的 v0 不受影响，画面保住。
        vids[0].classList.add('show')
        vids[1].classList.remove('show')
        const visibleSrcBefore = vids[0].src
        active = 1 // 故意与 show(=0) 脱节
        play('待机呼吸休闲', { loop: true })
        noVanish =
          vids[0].src === visibleSrcBefore && // 正显示的画面没被改 src
          shownIndex() === 0 && // 画面仍留在 v0（等解码好才会挪走）
          active === 1 // active 同步到新 next（v1）
        // 收尾：让 v1 解码完成，show 正常挪过去，别把自检状态留在脱节态
        vids[1].dispatchEvent(new Event('loadeddata'))
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
        // 羁绊进化：强制推一次变身演出，验证形态标题 + 特权 + 金色描边都到位
        onEvolve({ formLabel: '测试形态', line: '进化啦', perkText: '测试特权', anim: null })
        evolveProbe = {
          shown: bubble.classList.contains('show'),
          line: bubbleText.textContent,
          badge: bubble.classList.contains('evolve'),
        }
        hideBubble()
        // 桌面巡游：验证不同行为会播各自动画+台词、停下收气泡。
        // play() 会同步把逻辑 active 切到新视频（第 128 行），当场读 vids[active].src
        const acts = ((cfg.crawler || {}).activities) || {}
        const crawCfg = cfg.crawler || {}
        const travelLeft = crawCfg.travelLeft || '巡游走路-左'
        const travelRight = crawCfg.travelRight || '巡游走路-右'
        crawlKey = '' // 确保第一次算「行为切换」，会推一句台词
        // 往左走：应播朝左素材
        onCrawl({ active: true, activity: 'walk', dir: -1 })
        const crawlOn = document.body.classList.contains('crawling')
        const walkAnim = nameOf(vids[active].src)
        const walkLine = bubbleText.textContent
        const lineShown = bubble.classList.contains('show') && !!walkLine
        // 转身往右走：行为没变但方向变了，应播镜像的朝右素材
        onCrawl({ active: true, activity: 'walk', dir: 1 })
        const dirFlipAnim = nameOf(vids[active].src)
        // 小跑 + 害羞互动
        onCrawl({ active: true, activity: 'run', dir: -1 })
        const runAnim = nameOf(vids[active].src)
        const runLine = bubbleText.textContent
        onCrawl({ active: true, activity: 'shy', dir: -1 })
        const shyAnim = nameOf(vids[active].src)
        const shyLine = bubbleText.textContent
        onCrawl({ active: false })
        crawlProbe = {
          on: crawlOn,
          off: !document.body.classList.contains('crawling'),
          lineShown,
          // 移动类按方向选素材：左→左片、右→右片；驻足类(shy)来自各自配置池
          animPoolsOk:
            walkAnim === travelLeft &&
            dirFlipAnim === travelRight &&
            runAnim === travelLeft &&
            ((acts.shy || {}).anims || []).includes(shyAnim),
          // 转身会换素材（脚步方向跟位移方向）
          dirFlipOk: walkAnim !== dirFlipAnim,
          // 两份走路素材都在资源池里（能加载）
          travelOk: (boot.assets || []).includes(travelLeft) && (boot.assets || []).includes(travelRight),
          travelLeft,
          travelRight,
          // 换行为会换台词（不是一句话到底）
          lineChanged: !!runLine && runLine !== walkLine && !!shyLine && shyLine !== walkLine,
          lineCleared: !bubble.classList.contains('show'),
        }
        manualUntil = 0

        // 自绘气泡菜单：主页面 8 项 + 翻页子页渲染 + 开关切换
        let menuProbe
        try {
          // 第一屏不再有独立的 feast（喂白饭已并入喂一口的随机演出）
          const expected = ['chat', 'poke', 'rps', 'note', 'feed', 'speak', 'crawl', 'game', 'sleep', 'meme', '__more__']
          openActionMenu()
          const opened = actionMenu.classList.contains('show') && document.body.classList.contains('menu-open')
          const scrimOn = !!menuScrim && getComputedStyle(menuScrim).display === 'block' && getComputedStyle(menuScrim).pointerEvents === 'auto'
          const items = Array.from(actionMenuItems.querySelectorAll('.action-item'))
          const actions = items.map((b) => b.dataset.action)
          const itemsOk = expected.every((a) => actions.includes(a)) && items.every((b) => !!b.dataset.action)
          const titled = !!(actionMenuTitle && actionMenuTitle.textContent.trim())
          // 每个功能自带图标 + 主题色：ico 有内容，按钮挂上 --tint/--tint-bg，且颜色不止一种
          const tints = items.map((b) => (b.style.getPropertyValue('--tint') || '').trim())
          const tintOk =
            items.every((b) => {
              const ico = b.querySelector('.ico')
              return ico && ico.textContent.trim() && b.style.getPropertyValue('--tint-bg')
            }) && new Set(tints.filter(Boolean)).size > 1
          // 主页面应是宫格：page-main class + grid 布局 + 无 hint
          const gridOk =
            actionMenu.classList.contains('page-main') &&
            getComputedStyle(actionMenuItems).display === 'grid' &&
            !actionMenuItems.querySelector('.hint')
          // 更多页·目录（喂假分组数据，纯渲染）：每个分组是一个彩色宫格块
          renderMoreIndex([
            { title: '它现在的状态', icon: '📊', tint: '#4c9e6a', layout: 'grid', items: [{ ico: '💞', tint: '#e0679a', txt: '亲密度 80%', readonly: true }, { ico: '🍚', tint: '#4c9e6a', txt: '饱腹度 72%', readonly: true }] },
            { title: '设置', icon: '🎛️', tint: '#7d8a99', layout: 'grid', items: [{ ico: '🔊', tint: '#378add', txt: '提示音', action: 'sound' }, { ico: '🚪', tint: '#c0392b', txt: '退出', action: 'quit', danger: true }] },
          ])
          const tiles = Array.from(actionMenuItems.querySelectorAll('.group-tile'))
          const indexGridOk = menuPage === 'more' &&
            actionMenu.classList.contains('page-more') && !actionMenu.classList.contains('page-more-group') &&
            getComputedStyle(actionMenuItems).display === 'grid' && tiles.length === 2
          // 每个分组块带独立彩色图标（--tint）
          const tileTintOk = tiles.length === 2 && tiles.every((t) => {
            const ico = t.querySelector('.ico')
            return ico && ico.textContent.trim() && t.style.getPropertyValue('--tint')
          })
          // 目录页可滚动：items 的 min-height 必须为 0，否则 flex 子项撑到内容高度，
          // overflow-y:auto 不触发滚动，超出菜单的部分就被裁（用户报的"显示不全"）
          const scrollOk = getComputedStyle(actionMenuItems).minHeight === '0px' &&
            getComputedStyle(actionMenuItems).overflowY === 'auto'
          // 宫格等宽等高：所有 group-tile 的宽/高一致，长名字不撑破列（用户报的"大小不一样"）
          const tileGeoOk = tiles.length >= 2 && (() => {
            const ws = tiles.map((t) => t.getBoundingClientRect().width)
            const hs = tiles.map((t) => t.getBoundingClientRect().height)
            return Math.max(...ws) - Math.min(...ws) < 1 && Math.max(...hs) - Math.min(...hs) < 1
          })()
          // 点第一个分组块 → 进入组内页（宫格内容）
          if (tiles[0]) tiles[0].click()
          const gridBody = actionMenuItems.querySelector('.action-group-body.grp-grid')
          // 关键：不仅要 display:grid，还要真正可见（opacity=1 且 maxHeight 非 0），
          // 否则内容渲染了却被折叠样式藏起来——就是"点进去没下一级"的 bug。
          const bodyVisible = !!gridBody && (() => {
            const cs = getComputedStyle(gridBody)
            return cs.opacity === '1' && cs.maxHeight !== '0px' && cs.display === 'grid'
          })()
          const groupPageOk = menuPage === 'group' && actionMenu.classList.contains('page-more-group') && bodyVisible
          // 纯只读组（状态）用 2 列
          renderGroupPage(0)
          const infoBody = actionMenuItems.querySelector('.action-group-body.grp-info')
          const grpInfoOk = !!infoBody && getComputedStyle(infoBody).display === 'grid' &&
            getComputedStyle(infoBody).gridTemplateColumns.split(' ').length === 2
          // 功能组（非只读）用 3 列，且格子 min-width:0、文字换行——防止长文字撑宽导致出画
          renderGroupPage(1)
          const fitBody = actionMenuItems.querySelector('.action-group-body.grp-grid:not(.grp-info)')
          const fitItems = Array.from(actionMenuItems.querySelectorAll('.action-group-body.grp-grid:not(.grp-info) .action-item'))
          const gridFitOk = !!fitBody &&
            getComputedStyle(fitBody).gridTemplateColumns.split(' ').length === 3 &&
            fitItems.length > 0 && fitItems.every((it) => {
              const cs = getComputedStyle(it)
              const txt = it.querySelector('.txt')
              return cs.minWidth === '0px' && !!txt && getComputedStyle(txt).whiteSpace === 'normal'
            })
          // 组内返回 → 回到目录
          const backBtn = actionMenuItems.querySelector('[data-action="__more-back__"]')
          if (backBtn) backBtn.click()
          const backToIndexOk = menuPage === 'more' && actionMenuItems.querySelectorAll('.group-tile').length === 2
          const moreOk = indexGridOk && tileTintOk && scrollOk && tileGeoOk && groupPageOk && grpInfoOk && gridFitOk && backToIndexOk
          // 翻回主页面
          showMainPage()
          const backOk = actionMenuItems.querySelector('[data-action="__more__"]') != null
          closeActionMenu()
          const closed = !actionMenu.classList.contains('show') && !document.body.classList.contains('menu-open')
          const scrimOff = !!menuScrim && getComputedStyle(menuScrim).display === 'none'
          // 真实行为探针：右键开菜单后，左键点"菜单内非按钮区域"（标题栏/间隙）应能关闭。
          // 之前 window 兜底用 actionMenu.contains 判断，点到菜单内的空白不关——这是用户报的 bug。
          openActionMenu()
          const beforeBlankClick = menuOpen
          // 派发一个冒泡的 pointerdown，target 设为菜单标题（不是 .action-item）
          if (actionMenuTitle) {
            actionMenuTitle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
          }
          const blankClickCloses = beforeBlankClick && !menuOpen
          closeActionMenu()
          menuProbe = {
            rendered: items.length > 0,
            opened,
            closed,
            scrimOk: scrimOn && scrimOff,
            itemsOk,
            titled,
            tintOk,
            gridOk,
            moreOk,
            indexGridOk,
            tileTintOk,
            scrollOk,
            tileGeoOk,
            groupPageOk,
            grpInfoOk,
            gridFitOk,
            backToIndexOk,
            blankClickCloses,
            backOk,
            count: items.length,
          }
        } catch (e) {
          menuProbe = { error: String((e && e.message) || e) }
        }

        // 弹弓小游戏：纯逻辑探针（不真的开局，验证夹紧/反向弹射/抛物线/命中计分/布置）
        let gameProbe
        try {
          gameProbe =
            window.SlingshotGame && typeof window.SlingshotGame.probeLogic === 'function'
              ? window.SlingshotGame.probeLogic()
              : { error: 'slingshot 模块未加载' }
        } catch (e) {
          gameProbe = { error: String((e && e.message) || e) }
        }

        // 新素材玩法：梗图配图能挂上 pet:// URL、睡觉序列能进 sleeping 态再醒来
        let newMediaProbe
        try {
          onMeme({ url: 'pet://memes/' + encodeURIComponent('压力一只大肥鱼.png'), line: '探针' })
          const memeImgOk =
            !!bubbleImg &&
            bubbleImg.style.display === 'block' &&
            /^pet:\/\/memes\//.test(bubbleImg.getAttribute('src') || '')
          const memeLineOk = bubbleText.textContent === '探针'
          hideBubble()

          onSleep({ start: '睡觉-开始', loop: '睡觉-循环', end: '睡觉-起来', lines: ['Zzz'], wakeLine: '醒了' })
          const sleepOn = sleeping === true && document.body.classList.contains('sleeping')
          doWakeAnim({ end: '睡觉-起来', wakeLine: '醒了' })
          const wakeOk = sleeping === false && !document.body.classList.contains('sleeping')

          // 白饭演出：走分镜分支，确认没被当成单段"吃白饭"
          let feastOk = true
          const origPlay = typeof play === 'function'
          onFeast({ food: '吃白饭', fullness: 80, line: '探针开饭' })
          feastOk = origPlay && manualUntil > Date.now()
          hideBubble()

          newMediaProbe = {
            memeImgOk,
            memeLineOk,
            sleepOn,
            wakeOk,
            feastOk,
            petProtocolOk: /^pet:\/\//.test(bubbleImg ? 'pet://x' : ''),
          }
        } catch (e) {
          newMediaProbe = { error: String((e && e.message) || e) }
        }

        // 动作库：既要能点播，又要是独立页（不再平铺进更多页导致又乱又出画）
        let animLibProbe
        try {
          const probeAnim = (boot.assets || []).find((a) => a === '照镜子') || (boot.assets || [])[0]
          // (1) 点播链：带 anim 的项点击后直接 playByName，src 切到该动画
          const fake = makeItem({ action: '', ico: '▶', tint: '#378add', txt: '探针动画', anim: probeAnim }, 0, true)
          fake.click()
          const playedName = nameOf(vids[active].src)

          // (2) 动作库独立页：喂假分类数据同步渲染，验证它占据独立的 more 页而非平铺在更多页
          openActionMenu()
          const fakeLib = [
            { title: '待机动作', icon: '🎬', tint: '#378add', items: [{ ico: '▶', tint: '#378add', txt: probeAnim, anim: probeAnim }] },
            { title: '趣味动作', icon: '🎬', tint: '#2a9d8f', items: [{ ico: '▶', tint: '#2a9d8f', txt: probeAnim, anim: probeAnim }] },
            { title: '特殊时刻', icon: '🎬', tint: '#7b6cd4', items: [{ ico: '▶', tint: '#7b6cd4', txt: probeAnim, anim: probeAnim }] },
          ]
          renderMoreIndex(fakeLib, 'animlib')
          const libPageOk =
            menuPage === 'more' && groupBackSource === 'animlib' && /动作库/.test(actionMenuTitle.textContent)
          const libTiles = actionMenuItems.querySelectorAll('.group-tile').length
          const libBack = !!actionMenuItems.querySelector('[data-action="__animlib-back__"]')
          // (3) 点分类进组内 → 动画项可见 → 点返回回到动作库目录
          const firstTile = actionMenuItems.querySelector('.group-tile')
          if (firstTile) firstTile.click()
          const inGroup = menuPage === 'group' && groupBackSource === 'animlib'
          const groupAnimBtns = actionMenuItems.querySelectorAll('.action-group-body .action-item')
          const groupBack = actionMenuItems.querySelector('[data-action="__more-back__"]')
          if (groupBack) groupBack.click()
          const backToLib =
            menuPage === 'more' && groupBackSource === 'animlib' &&
            !!actionMenuItems.querySelector('[data-action="__animlib-back__"]')

          // (4) 更多页的动作库 tile 带 jump 标记 → 点一下直达分类页，
          // 不再落进只有单个「播放全部动作」按钮的组内页那一级。
          // 放在所有 DOM 读取之后：showAnimLibPage 内部有异步 IPC，避免它覆盖上面的断言。
          renderMoreIndex([{ title: '动作库', icon: '🎬', tint: '#7b6cd4', jump: 'animlib' }])
          const jumpTile = actionMenuItems.querySelector('.group-tile')
          const jumpTileOk = !!jumpTile
          if (jumpTile) jumpTile.click()
          const jumpNoGroupPage = menuPage !== 'group'

          closeActionMenu()

          animLibProbe = {
            hasAnimField: !!probeAnim,
            played: playedName === probeAnim,
            playedName,
            want: probeAnim,
            libPageOk,
            libTiles,
            libBack,
            inGroup,
            groupHasItems: groupAnimBtns.length > 0,
            backToLib,
            jumpTileOk,
            jumpNoGroupPage,
          }
        } catch (e) {
          animLibProbe = { error: String((e && e.message) || e) }
        }

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
          reveal: { revealOk, anyVisible, noVanish },
          parts: partProbe,
          note: noteProbe,
          speak: speakProbe,
          chat: chatProbe,
          evolve: evolveProbe,
          crawl: crawlProbe,
          actionMenu: menuProbe,
          game: gameProbe,
          newMedia: newMediaProbe,
          animLib: animLibProbe,
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
