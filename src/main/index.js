'use strict'

const { app, BrowserWindow, screen, ipcMain, Menu, protocol, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const { loadConfig, saveConfig, listAssets, loadChatConfig, saveChatConfig } = require('./config')
const { ASSETS_DIR, ROOT } = require('./paths')
const { createWatcher } = require('./watcher')
const { createTray } = require('./tray')
const { createFlight, step } = require('../shared/physics')
const crawl = require('../shared/crawler')
const { classify, menuGroups } = require('../shared/animations')
const sfx = require('./sfx')
const chat = require('./chat')
const feed = require('./feed')
const mood = require('./mood')
const calendar = require('./calendar')
const routine = require('./routine')
const coins = require('./coins')
const digest = require('./digest')
const achieve = require('./achieve')
const lonely = require('./lonely')
const note = require('./note')
const evolve = require('./evolve')

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

// 气泡菜单支持的全部动作，分发器和自检共用，避免两边列表漂移
const MENU_ACTIONS = [
  'chat', 'poke', 'rps', 'note', 'feed', 'speak', 'crawl', 'quit', // 主页面
  'sound', 'clickSfx', 'clickThrough', 'reset', 'reload', 'audition', // 设置
  'openWorkBuddy', 'openCursor', 'openCwdCursor', 'openCwdTerminal', 'openCwdFinder', // 打开
  'digest', 'replayEvolve', // 查看/回看
  'game', // 弹弓弹射小游戏
]

protocol.registerSchemesAsPrivileged([
  { scheme: 'pet', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
])

// 桌宠是常驻进程，任何一个偶发异常都不该让它当场死掉
process.on('uncaughtException', (err) => {
  console.error('[pet] 未捕获异常，已忽略：', err && err.message)
})

const SELFTEST = process.argv.includes('--selftest')
const SELFTEST_FILE = '/tmp/pet-selftest.json'
const selftest = { startedAt: new Date().toISOString() }

function selftestDone(extra) {
  Object.assign(selftest, extra || {}, { finishedAt: new Date().toISOString() })
  try {
    require('node:fs').writeFileSync(SELFTEST_FILE, JSON.stringify(selftest, null, 2))
  } catch (e) {
    /* ignore */
  }
  if (SELFTEST) app.quit()
}

let win = null
let chatWin = null
let cfg = null
let pools = null
let watcher = null
let flight = null
let flightTimer = null
let crawler = null
let crawlerTimer = null
let crawlerOn = false
let tray = null
let lastKnown = { phase: 'idle', project: '', detail: '', source: 'none', title: '' }

function boundsOf() {
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  return {
    x: wa.x,
    y: wa.y,
    width: Math.max(0, wa.width - b.width),
    height: Math.max(0, wa.height - b.height),
  }
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  const w = cfg.pet.width
  const h = cfg.pet.height
  const pos = cfg.position || { x: wa.x + wa.width - w - 48, y: wa.y + wa.height - h - 12 }

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: w,
    height: h,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applyClickThrough()
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  win.on('moved', persistPosition)
  win.on('closed', () => {
    win = null
  })

  if (SELFTEST) {
    selftest.windowCreated = true
    win.webContents.once('did-finish-load', () => {
      selftest.rendererLoaded = true
    })
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) selftest.rendererError = String(message).slice(0, 400)
    })
    setTimeout(() => selftestDone({ timedOut: true }), 25000)
  }

  if (process.argv.includes('--inputlog')) {
    setInterval(() => {
      try {
        require('node:fs').writeFileSync('/tmp/pet-bounds.json', JSON.stringify(win.getBounds()))
      } catch {}
    }, 1500)
  }
}

// ---- 聊天窗口 ----
// 桌宠窗口 focusable:false 放不了输入框，聊天用独立窗口。单例，关了再开重新建。
function chatHint() {
  const cc = loadChatConfig()
  const on = cfg.chat && cfg.chat.enabled !== false && cc.enabled && cc.baseUrl && cc.apiKey
  return on
    ? '回车发送 · 在线模式（大模型）'
    : '回车发送 · 离线模式（没配模型，也能聊）'
}

function openChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show()
    chatWin.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workArea
  const cw = 380
  const ch = 520
  // 默认放在工作区右侧、偏下，避开正中间
  const x = Math.round(wa.x + wa.width - cw - 60)
  const y = Math.round(wa.y + wa.height - ch - 40)
  chatWin = new BrowserWindow({
    x,
    y,
    width: cw,
    height: ch,
    minWidth: 300,
    minHeight: 360,
    title: '和大肥鱼聊天',
    backgroundColor: '#f7f5ef',
    webPreferences: {
      preload: path.join(__dirname, '..', 'chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  chatWin.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'))
  chatWin.on('closed', () => {
    chatWin = null
  })
}

// 组装当前状态上下文，喂给 chat.reply 让回答能带上"我在干嘛"
function chatContext() {
  const ag = agentOf(lastKnown.source)
  const phase = labelOf(lastKnown.phase)
  const what = whatOf(lastKnown)
  return { agentLabel: ag.label, phaseLabel: phase, what }
}

// 合并 shared 的 chat 段 + 用户私有的模型配置，给 chat.reply 用
function chatConfig() {
  const cc = loadChatConfig()
  return Object.assign({}, cfg.chat || {}, cc)
}

// 鼠标穿透：开启后整窗彻底不接收鼠标事件，鱼变成纯装饰，鼠标直接穿过去点到下面的窗口。
//
// 这里**故意不做 hover 恢复**。之前的实现是「鼠标挪到鱼身上就恢复可点击」，听起来贴心，
// 实际等于没开：鼠标不在鱼身上时穿不穿透都没区别（你本来也点不到鱼），而鼠标一到鱼身上
// 又被恢复了。而且 hover 状态跟开关不同步——切换瞬间鼠标正好在鱼身上的话，之后就再也
// 收不到 hover 上报，行为完全取决于切换时鼠标在哪。
//
// 代价是开启后右键菜单也唤不出来，所以开关在托盘菜单里也放了一份，随时能关回来。
function applyClickThrough() {
  if (!win) return
  const on = !!cfg.pet.clickThrough
  win.setIgnoreMouseEvents(on, { forward: false })
  // 开了之后肉眼看不出区别（鱼本来就是透明的），让鱼淡一点当反馈
  win.webContents.send('pet:clickthrough', on)
}

function toggleClickThrough() {
  cfg.pet.clickThrough = !cfg.pet.clickThrough
  saveConfig(cfg)
  applyClickThrough()
  if (tray && tray.rebuild) tray.rebuild() // 托盘菜单上的文案要跟着变
}

function persistPosition() {
  if (!win) return
  const [x, y] = win.getPosition()
  cfg.position = { x, y }
  saveConfig(cfg)
}

function stopFlight() {
  if (flightTimer) {
    clearInterval(flightTimer)
    flightTimer = null
  }
  flight = null
}

// 点播走路类动画时真的走一段：把窗口在 ms 内平移 dist（会被屏幕边界夹住）
function startWalk(dist, ms) {
  if (crawlerOn) stopCrawl() // 手动走一段就接管巡游
  stopFlight()
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const from = b.x
  const to = Math.max(wa.x, Math.min(wa.x + wa.width - b.width, from + dist))
  const t0 = Date.now()
  stopFlightTimerOnly()
  flightTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopFlightTimerOnly()
      return
    }
    const t = Math.min(1, (Date.now() - t0) / ms)
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    try {
      win.setPosition(Math.round(from + (to - from) * e), b.y)
    } catch {
      stopFlightTimerOnly()
      return
    }
    if (t >= 1) {
      stopFlightTimerOnly()
      win.webContents.send('pet:walk-done')
      persistPosition()
    }
  }, 16)
}

function startFlight(vx, vy) {
  if (crawlerOn) stopCrawl() // 抛掷时交还窗口控制权
  // 弹弓模式每发消耗一发弹药，并同步 HUD
  if (slingshotMode && !sgTransition) {
    sgAmmo = Math.max(0, sgAmmo - 1)
    sendAmmo()
    sgShotHits = 0 // 新的一发，重置本发命中计数（每发上限）
  }
  const b = win.getBounds()
  flight = createFlight(b.x, b.y, vx, vy)
  const bounds = boundsOf()
  // 弹弓模式：把物理顶边上移一段，让鱼能飞到高处罐塔；但绝不关闭反弹——
  // 之前 ceiling:false 时鱼一路飞出屏幕，macOS 把窗口钳制在屏幕内、物理还在往上，
  // 就出现"弹出去卡在顶部"。保留反弹 + 顶边上移，鱼到顶就弹回，不会卡死。
  if (slingshotMode) {
    bounds.y -= SG_CEIL_RAISE
    bounds.height += SG_CEIL_RAISE
  }
  stopFlightTimerOnly()
  let prev = Date.now()
  let prevFishCx = null, prevFishCy = null // 上一帧鱼身中心，用于扫掠式碰撞（力度加大后防隧穿）
  flightTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopFlightTimerOnly()
      return
    }
    const now = Date.now()
    const dt = Math.min(0.032, Math.max(0.001, (now - prev) / 1000))
    prev = now
    try {
      // 始终保留顶边反弹（不再 ceiling:false）——顶边已按 SG_CEIL_RAISE 上移，
      // 既够得到高处罐塔，又不会飞出屏幕被系统钳制卡在顶部。
      step(flight, dt, bounds)
      win.setPosition(Math.round(flight.x), Math.round(flight.y))
      // 弹弓模式：鱼中心（贴底，取偏下位置）命中目标检测。
      // 传上一帧中心做扫掠判定——力度加大后单帧可移动 40px+，只看当前点会漏撞。
      if (slingshotMode) {
        const fishCx = flight.x + b.width / 2
        const fishCy = flight.y + b.height * 0.68
        checkTargetHits(fishCx, fishCy, prevFishCx, prevFishCy)
        prevFishCx = fishCx
        prevFishCy = fishCy
      }
    } catch (e) {
      stopFlightTimerOnly()
      return
    }
    if (!flight.flying) {
      stopFlightTimerOnly()
      // 弹弓模式：每次落地自动回到左侧中部发射台，才能连续弹射右侧罐塔，
      // 否则鱼停在屏幕底部，下次只能往上弹，玩不了第二发。
      // 过关/失败由 onLevelClear/onLevelFail 各自归位，这里不重复插手。
      if (slingshotMode && sgLaunch && win && !win.isDestroyed() && !sgTransition) {
        const cleared = sgTargets.length > 0 && sgTargets.every((t) => !t.alive)
        if (!cleared && sgAmmo <= 0) {
          onLevelFail() // 弹药打光还没清 → 本关重来
        } else {
          try { win.setPosition(sgLaunch.x, sgLaunch.y) } catch {}
        }
      }
      win.webContents.send('pet:landed')
      persistPosition()
    }
  }, 16)
}

function stopFlightTimerOnly() {
  if (flightTimer) {
    clearInterval(flightTimer)
    flightTimer = null
  }
}

// ---- 桌面巡游（免授权基础版）----
// 鱼只在屏幕底边左右巡游，走走停停、张望伸懒腰，鼠标靠近会害羞/打招呼/溜走。
// 只用窗口坐标 + 全局鼠标位置，不读别的窗口标题栏，不需要系统授权。
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function crawlBounds() {
  const b = win.getBounds()
  const disp = screen.getDisplayMatching(b)
  const full = disp.bounds
  const wa = disp.workArea
  return {
    x: full.x,
    y: full.y,
    width: Math.max(0, full.width - b.width),
    height: Math.max(0, full.height - b.height),
    // 底边贴工作区下沿（避开 Dock）；鱼只在底边活动，不再需要顶边
    floorY: wa.y + wa.height - b.height - 2,
    w: b.width,
    h: b.height,
  }
}

function stopCrawlTimerOnly() {
  if (crawlerTimer) {
    clearInterval(crawlerTimer)
    crawlerTimer = null
  }
}

function stopCrawl() {
  crawlerOn = false
  crawler = null
  stopCrawlTimerOnly()
  if (cfg.crawler) cfg.crawler.on = false
  if (win && !win.isDestroyed()) win.webContents.send('pet:crawl', { active: false })
  saveConfig(cfg)
}

function startCrawl() {
  if (!win || win.isDestroyed() || (cfg.crawler && cfg.crawler.enabled === false)) return
  stopFlight() // 跟抛掷/走路互斥
  stopCrawlTimerOnly()
  const b = win.getBounds()
  const bounds = crawlBounds()
  crawlerOn = true
  cfg.crawler = cfg.crawler || {}
  cfg.crawler.on = true

  crawler = crawl.create(
    clampNum(b.x, bounds.x, bounds.x + bounds.width),
    bounds.floorY,
    Date.now(),
    b.x < bounds.x + bounds.width / 2 ? 1 : -1
  )

  let mouse = null
  let tick = 0
  let lastX = NaN
  let lastY = NaN
  let lastDir = 0
  crawlerTimer = setInterval(() => {
    if (!crawlerOn || !crawler || !win || win.isDestroyed()) {
      stopCrawl()
      return
    }
    const now = Date.now()
    // 鼠标位置不必每帧都问系统（getCursorScreenPoint 是同步跨进程调用），
    // 每 4 帧（约 130ms）取一次足够——170px 的互动半径不会因为你手速快而漏掉。
    if (tick++ % 4 === 0) {
      try {
        mouse = screen.getCursorScreenPoint()
      } catch (e) {
        mouse = null
      }
    }
    let changed = false
    try {
      const r = crawl.step(crawler, 0, bounds, mouse, now)
      changed = !!r.changed
      const x = Math.round(crawler.x)
      const y = Math.round(crawler.y)
      // 坐标没变就别调 setPosition：macOS 每次调用都会触发窗口重绘合成，
      // 停顿/贴边时坐标不变，跳过能明显减少无谓的合成、让动画更顺。
      if (x !== lastX || y !== lastY) {
        win.setPosition(x, y)
        lastX = x
        lastY = y
      }
    } catch (e) {
      stopCrawl()
      return
    }
    // 行为或方向一变就推给渲染层：行为换动画+台词，方向换左/右走路素材（脚步跟位移一致）
    if (changed || crawler.dir !== lastDir) {
      win.webContents.send('pet:crawl', {
        active: true,
        activity: crawler.activity,
        dir: crawler.dir,
      })
      lastDir = crawler.dir
    }
  }, 33)

  win.webContents.send('pet:crawl', { active: true, activity: 'walk', dir: crawler.dir })
  saveConfig(cfg)
}

function toggleCrawl() {
  if (crawlerOn) stopCrawl()
  else startCrawl()
}

function crawlLabel() {
  return crawlerOn ? '🐾 停下巡游' : '🐾 桌面巡游'
}

// 「动作 → 分类 → 具体动画」三级点播，素材全在菜单里，跟参考项目一个路子
function actionMenu() {
  if (!pools) return { label: '动作（素材还没加载）', enabled: false }
  const groups = menuGroups(pools, cfg)
  return {
    label: '动作',
    submenu: groups.map((g) => ({
      label: `${g.label}（${g.items.length}）`,
      submenu: g.items.map((it) => ({
        label: it.label,
        click: () => win && win.webContents.send('pet:play', it.name),
      })),
    })),
  }
}

// 到底是哪个 agent 在处理哪个问题：徽章用配置里的名字/颜色，"问题"优先取会话标题
function agentOf(source) {
  return (cfg.agents && cfg.agents[source]) || { label: source === 'none' ? '没有在跑' : source || '—', color: '#8a8a8a' }
}

// 是否展示"每一步在干嘛"
function stepsOn() {
  return !(cfg && cfg.steps && cfg.steps.enabled === false)
}

function whatOf(s) {
  const t = s && (s.title || s.project)
  return t ? String(t).slice(0, 28) : ''
}

// ===== 设置类动作：原生菜单和自绘气泡子页共用 =====
function cycleSound() {
  const cur = sfx.modeOf(cfg)
  const next = cur === 'voice' ? 'tone' : cur === 'tone' ? 'off' : 'voice'
  cfg.sound.enabled = next !== 'off'
  if (next !== 'off') cfg.sound.mode = next
  saveConfig(cfg)
  sfx.preview(cfg)
}
function toggleClickSfx() {
  cfg.sound.click = cfg.sound.click || {}
  cfg.sound.click.enabled = cfg.sound.click.enabled === false
  saveConfig(cfg)
  if (cfg.sound.click.enabled !== false) sfx.click(cfg, true)
}
function reloadConfig() {
  const assets = listAssets()
  pools = classify(assets, cfg)
  sfx.resetEdgeProbe()
  win.webContents.send('pet:reload-config', { config: cfg, pools })
  lastMoodJson = ''
  pushMood()
}
function openAudition() {
  if (sfx.auditionPath()) shell.openPath(sfx.auditionPath())
}
function openTool(name) {
  if (name === 'workbuddy') execFile('open', ['-a', 'WorkBuddy'], () => {})
  else if (name === 'cursor') execFile('open', ['-a', 'Cursor'], () => {})
  else if (name === 'cwd-cursor' && currentCwd()) execFile('open', ['-a', 'Cursor', currentCwd()], () => {})
  else if (name === 'cwd-terminal' && currentCwd()) execFile('open', ['-a', 'Terminal', currentCwd()], () => {})
  else if (name === 'cwd-finder' && currentCwd()) shell.showItemInFolder(currentCwd())
}

// 注意：这里必须是同步函数。菜单 label 需要字符串，
// 一旦写成 async 返回的就是 Promise，Electron 构建菜单时会直接抛类型转换错误，整个菜单弹不出来。
function soundMenuLabel() {
  const m = sfx.modeOf(cfg)
  if (m === 'voice') return `提示音：语音（${sfx.voiceLabel(cfg)}）`
  if (m === 'tone') return '提示音：音效'
  return '提示音：关'
}

// 小金库：显示余额，点一下播对应档位的「余额-」动画
function coinsMenuItems() {
  const s = coins.snapshot(cfg)
  if (!s.enabled) return []
  const label = s.tier ? `小金库：${s.total} 枚（${s.tier.label}）` : `小金库：${s.total} 枚`
  return [
    {
      label,
      click: () => {
        const t = coins.snapshot(cfg).tier
        if (t && t.anim) win.webContents.send('pet:play', t.anim)
      },
    },
  ]
}

// 递小纸条：手动点一张关怀便签（自动的那张由 tick 里的 applyNote 负责）
// 抽成 doNote() 供原生菜单和自绘气泡菜单共用
function doNote() {
  const d = note.force(cfg)
  if (d && win && !win.isDestroyed()) win.webContents.send('pet:note', d)
}
function noteMenuItems() {
  if ((cfg.note || {}).enabled === false) return []
  return [{ label: '递张小纸条', click: doNote }]
}

// 猜拳规则：石头砸剪刀、剪刀布、布包石头。抽成纯函数好自检
function rpsDecide(mine, theirs) {
  const beats = { 石头: '剪刀', 剪刀: '布', 布: '石头' }
  if (theirs === mine) return 'draw'
  return beats[mine] === theirs ? 'win' : 'lose'
}

// 猜拳：玩家出手，它随机出手，判胜负后推给渲染层播动画+台词，顺手记一笔小金库
// 抽成 doRps() 供原生菜单和自绘气泡菜单共用（气泡里点一下就随机出一只手）
function doRps(mine) {
  const r = cfg.rps || {}
  const hands = r.hands && r.hands.length ? r.hands : ['石头', '剪刀', '布']
  if (hands.indexOf(mine) < 0) mine = hands[Math.floor(Math.random() * hands.length)]
  const theirs = hands[Math.floor(Math.random() * hands.length)]
  const result = rpsDecide(mine, theirs)
  // 赢+币 输-币，平局不动。note 里带 gift 判定，攒够照样拆礼物
  if (result === 'win' || result === 'lose') {
    const gain = coins.note(cfg, result === 'win' ? 'success' : 'error')
    if (gain && gain.gift) {
      const gift = (cfg.coins || {}).giftAnims || []
      if (gift.length && win) win.webContents.send('pet:play', gift[Math.floor(Math.random() * gift.length)])
    }
    pushMood()
  }
  if (win) win.webContents.send('pet:rps', { mine, theirs, result })
}
function rpsMenuItems() {
  const r = cfg.rps || {}
  if (r.enabled === false) return []
  const hands = r.hands && r.hands.length ? r.hands : ['石头', '剪刀', '布']
  return [
    {
      label: '猜个拳',
      submenu: hands.map((mine) => ({
        label: `我出${mine}`,
        click: () => doRps(mine),
      })),
    },
  ]
}

// 成就：判定需要的四个数字分散在 mood / coins / digest 里，这里凑齐了一次性喂进去
function checkAchievements() {
  const now = Date.now()
  const day = digest.today(cfg) || {}
  const got = achieve.check(cfg, {
    streak: mood.trailingSuccesses(cfg, now),
    dayTotal: day.n || 0,
    dayOk: day.ok || 0,
    coins: coins.value(cfg) || 0,
    bond: mood.snapshot(cfg).bond || 0,
  })
  for (const it of got) {
    if (!win) break
    win.webContents.send('pet:achieve', { anim: it.anim, line: it.line || '', label: it.label || '' })
    sfx.speakText(cfg, it.line || `达成成就：${it.label || ''}`, true)
  }
}

// 成就进度：点开看解锁了哪些
function achieveMenuItems() {
  const s = achieve.snapshot(cfg)
  if (!s.enabled || !s.total) return []
  const sub = s.unlocked.length
    ? s.unlocked.map((u) => ({ label: `${u.label} ✓`, enabled: false }))
    : [{ label: '还没解锁，接着加油', enabled: false }]
  return [{ label: `成就（${s.done}/${s.total}）`, submenu: sub }]
}

// 羁绊进化：亲密度到档 → 播变身演出 + 记解锁形态
function fireEvolve(ev) {
  if (!ev || !win || win.isDestroyed()) return
  win.webContents.send('pet:evolve', ev)
  sfx.speakText(cfg, `${ev.formLabel}！${ev.line}`, true)
}

function checkEvolve() {
  const ev = evolve.check(cfg)
  if (ev) fireEvolve(ev)
}

// 状态子菜单：当前形态 + 各档解锁情况。点可回看任意已解锁形态的演出
function evolveMenuItems() {
  const s = evolve.snapshot(cfg)
  if (!s.enabled || !s.total) return []
  const seen = new Set(s.seen)
  const sub = evolve.levelsOf(cfg).map((lv, i) => {
    const f = evolve.formOf(cfg, lv.key) || {}
    const got = seen.has(lv.key)
    return {
      label: `${got ? '✓' : '·'} ${i + 1}. ${f.formLabel || lv.label}${got ? '' : `（亲密度 ${lv.at}）`}`,
      enabled: got,
      ...(got ? { click: () => fireEvolve(evolve.preview(cfg, lv.key)) } : {}),
    }
  })
  sub.push({ type: 'separator' })
  sub.push({
    label: `回看当前形态：${s.formLabel}`,
    click: () => fireEvolve(evolve.replay(cfg)),
  })
  return [{ label: `形态：${s.formLabel}（${s.unlocked}/${s.total}）`, submenu: sub }]
}

// 每日回顾：点一下念一句今天的战报
function digestMenuItems() {
  const t = digest.today(cfg)
  if (!t) return []
  return [
    {
      label: `今天干了啥（${t.n} 轮 · 成 ${t.ok}）`,
      click: () => sayDigest(),
    },
  ]
}

function sayDigest() {
  const line = digest.line(cfg)
  sfx.speakText(cfg, line, true)
  if (win) win.webContents.send('pet:digest', { line })
}

// 心情 / 亲密度：只在菜单里显示，点不动。关掉时返回空数组被展开运算符吃掉
function moodMenuItems() {
  const s = mood.snapshot(cfg)
  if (!s.enabled) return []
  const label = { happy: '开心', calm: '平静', sad: '有点蔫' }[s.mood] || s.mood
  const items = [{ label: `心情：${label}${s.sulking ? '（赌气中，别戳它）' : ''}`, enabled: false }]
  if (s.bond != null) {
    items.push({ label: `亲密度：${s.bond}%${s.level ? ' · ' + s.level.label : ''}`, enabled: false })
  }
  return items
}

// 喂点东西：互动操作，留在顶层。饱腹度关掉时返回空数组（展开运算符会吃掉）
// 喂一口：抽成 doFeed() 供原生菜单和自绘气泡菜单共用
function doFeed() {
  if (feed.fullness(cfg) == null) return
  const food = feed.pickFood(cfg)
  const r = feed.feed(cfg, food)
  if (!r || !win) return
  const fed = feed.moodOf(cfg, r.after)
  win.webContents.send('pet:feed', {
    food: r.food,
    fullness: r.after,
    mood: fed,
    line: feed.lineFor(cfg, fed),
  })
  bumpBond('feed')
  sfx.click(cfg, true) // 喂食也出一声，跟手
}
function feedMenuItems() {
  if (feed.fullness(cfg) == null) return []
  const food = feed.pickFood(cfg)
  const occasion = feed.occasionOf(cfg)
  const label = occasion
    ? `喂点东西（今天${occasion}，想吃${food.replace(/^吃/, '')}）`
    : `喂点东西（现在想吃${food.replace(/^吃/, '')}）`
  return [{ label, click: doFeed }]
}

// 饱腹度只读展示，归到「状态」子菜单
function feedStatusItem() {
  const v = feed.fullness(cfg)
  if (v == null) return null
  return { label: `饱腹度：${Math.round(v)}%`, enabled: false }
}

// 过滤掉 null / false（关闭的功能返回的占位），Electron 模板不接受这些
const compact = (arr) => arr.filter(Boolean)

function clickThroughLabel() {
  return cfg.pet.clickThrough ? '鼠标穿透：开（点不到我，从托盘图标关）' : '鼠标穿透：关（可以拖我）'
}

// 同样必须同步：返回 Promise 会让整个菜单弹不出来
function clickMenuLabel() {
  const c = (cfg && cfg.sound && cfg.sound.click) || {}
  const n = sfx.clickCount()
  const on = c.enabled !== false
  return `点击音效：${on ? `开（${n} 个随机）` : '关'}`
}

// 「它刚做了啥」：把会话记录里回溯出来的最近几步列出来（新的在上）
function stepMenu() {
  if (!stepsOn()) return { label: '最近步骤（已关闭）', enabled: false }
  const steps = (lastKnown && lastKnown.steps) || []
  if (!steps.length) return { label: '最近步骤（还没抓到）', enabled: false }
  return {
    label: `最近步骤（${agentOf(lastKnown.source).label}）`,
    submenu: steps.slice(0, 8).map((st, i) => ({
      label: `${i === 0 ? '现在 ' : ''}${st.verb || st.tool}${st.target ? ' ' + st.target : ''}`,
      enabled: i === 0,
      click: () => {},
    })),
  }
}

// 菜单要等三路探测结果，但绝不能被探测卡住：超时就当"都没在跑"，先把菜单弹出来
async function pollAllSafe() {
  if (!watcher) return []
  const guard = new Promise((r) => setTimeout(() => r(null), 1500))
  const r = await Promise.race([watcher.pollAll().catch(() => null), guard])
  return r || []
}

// 只负责拼模板（自检也复用），不弹窗
async function buildMenuTemplate() {
  const all = await pollAllSafe()
  const statusItems = all.length
    ? all.map((a) => {
        const ag = agentOf(a.source)
        const w = whatOf(a)
        return {
          label: `${ag.label}：${labelOf(a.phase)}${w ? ' · ' + w : ''}`,
          enabled: a.phase !== 'idle',
          click: () => pushState(a, true),
        }
      })
    : [{ label: '都没在跑，一起摸鱼中~', enabled: false }]

  // 状态类（只读 + 查看）——收进「状态」子菜单
  const statusMenu = {
    label: '状态',
    submenu: compact([
      ...moodMenuItems(),
      ...evolveMenuItems(),
      feedStatusItem(),
      ...coinsMenuItems(),
      ...digestMenuItems(),
      ...achieveMenuItems(),
      { label: '各 agent 状态（点开看各自在忙啥）', submenu: statusItems },
      stepMenu(),
    ]),
  }

  // 打开工具 / 项目——收进「打开」子菜单
  const cwd = currentCwd()
  const openMenu = {
    label: '打开',
    submenu: compact([
      { label: '打开 WorkBuddy', click: () => openTool('workbuddy') },
      { label: '打开 Cursor', click: () => openTool('cursor') },
      cwd && { label: '用 Cursor 打开当前项目', click: () => openTool('cwd-cursor') },
      cwd && { label: '在终端打开当前项目', click: () => openTool('cwd-terminal') },
      cwd && { label: '在访达中显示当前项目', click: () => openTool('cwd-finder') },
    ]),
  }

  // 声音 / 穿透 / 位置 / 重载——收进「设置」子菜单
  const settingsMenu = {
    label: '设置',
    submenu: compact([
      { label: soundMenuLabel(), click: cycleSound },
      sfx.auditionPath() && { label: '挑语音音色…（试听并复制配置）', click: openAudition },
      sfx.clickAvailable() && { label: clickMenuLabel(), click: toggleClickSfx },
      { label: clickThroughLabel(), click: () => toggleClickThrough() },
      { label: '回到屏幕右下角', click: () => resetPosition() },
      { label: '重载配置', click: reloadConfig },
    ]),
  }

  // 顶层只留高频互动 + 三个分组，31 项 → 13 项
  return Menu.buildFromTemplate([
    {
      label: `现在：${labelOf(lastKnown.phase)} · ${agentOf(lastKnown.source).label}${
        whatOf(lastKnown) ? ' · ' + whatOf(lastKnown) : ''
      }`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '💬 跟它聊聊', click: () => openChatWindow() },
    { label: '摸一下', click: () => win.webContents.send('pet:poke') },
    ...rpsMenuItems(),
    ...noteMenuItems(),
    ...feedMenuItems(),
    actionMenu(),
    { label: '它在干嘛？', click: () => speakNow() },
    { label: crawlLabel(), click: () => toggleCrawl() },
    { type: 'separator' },
    statusMenu,
    openMenu,
    settingsMenu,
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

async function showMenu() {
  let t
  try {
    t = await buildMenuTemplate()
  } catch (e) {
    // 兜底：宁可弹个精简菜单，也不要点了右键毫无反应
    console.error('[pet] 完整菜单构建失败，降级为精简菜单：', e)
    t = Menu.buildFromTemplate([
      { label: '摸一下', click: () => win.webContents.send('pet:poke') },
      { label: '回到屏幕右下角', click: () => resetPosition() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  }
  t.popup({ window: win })
}

// ===== 自绘气泡菜单：窗口临时向上扩展，给鱼头顶腾出放菜单的空间 =====
// 鱼贴窗口底显示，所以只把「顶部往上顶 + 高度加大」，底边坐标不变 →
// 鱼在屏幕上的位置一动不动，菜单浮层就长在原头顶那片空白里。
const MENU_EXTRA_H = 380 // 菜单区额外高度：主页面 8 项，更多页靠浮层内滚动
let menuOrigBounds = null // 打开前的窗口 bounds，关闭时精确还原

function expandForMenu() {
  if (!win || win.isDestroyed()) return
  if (menuOrigBounds) return // 已经开着，别重复扩
  const b = win.getBounds()
  menuOrigBounds = b
  const wa = screen.getDisplayMatching(b).workArea
  // 底边不动，往上长；但顶端不能越过工作区顶部，越了就少扩一点
  const bottom = b.y + b.height
  const newTop = Math.max(wa.y, b.y - MENU_EXTRA_H)
  const newH = bottom - newTop
  try {
    win.setBounds({ x: b.x, y: newTop, width: b.width, height: newH })
  } catch (e) {
    console.error('[pet] 菜单扩窗失败：', e)
  }
}

function restoreFromMenu() {
  if (!win || win.isDestroyed() || !menuOrigBounds) return
  const b = menuOrigBounds
  menuOrigBounds = null
  try {
    win.setBounds(b)
  } catch (e) {
    console.error('[pet] 菜单恢复窗口失败：', e)
  }
}

// ---- 弹弓模式 ----
// 弹射的就是这只真桌宠窗口本身：不扩窗、不隐藏鱼，渲染层只叠一根弹弓 HUD。
// 发射直接复用已有的 pet:throw → startFlight 物理（重力/撞墙反弹/落地/位置持久化）。
// 这里保留常量与状态位，供自检断言、以及未来可能的模式级行为使用。
const GAME_W = 320 // 与桌宠窗口同尺寸——弹弓模式不改变窗口大小
const GAME_H = 280
let slingshotMode = false

// ---- 弹弓目标层：一个覆盖屏幕、鼠标穿透的透明窗口，画一排可击落的罐子 ----
let targetWin = null
let sgTargets = [] // [{id,x,y,r,pts,alive}] x/y 是屏幕绝对坐标（用于碰撞）
let sgArea = null // 目标层窗口的屏幕矩形 {x,y,width,height}
let sgLaunch = null // 发射台：{x,y,w,h} 鱼被挪到的位置（屏幕左侧中部）
let sgOrigBounds = null // 进入弹弓模式前鱼的窗口位置，退出时还回去
let sgScore = 0
let targetSeq = 0
let sgAnimTimer = null   // 移动靶动画定时器
let sgAnimT0 = 0         // 动画起始时间
let sgShotHits = 0       // 本发已命中罐子数（每发上限，替代时间冷却）

// ---- 关卡系统 ----
// 每关一个格子图案：'#' 普通罐 / '@' 装甲罐(要打 2 次) / ' ' 空位。
// 图案从下往上读（数组末项是底排），列居中铺在右侧。多种造型轮转 = 不再是"只有一关"。
const SG_LEVELS = [
  { name: '金字塔',   r: 23, rows: ['  #  ', ' ### ', '#####'] },
  { name: '双子塔',   r: 22, rows: [' #  # ', ' #  # ', '##  ##'] },
  { name: '堡垒',     r: 22, rows: ['  @  ', ' ##### ', '#######'] },
  { name: '一字长蛇', r: 21, rows: ['#######', '  @ @  '] },
  { name: '空中梯队', r: 21, rows: ['   #   ', '  ###  ', ' ##### ', '### ###'] },
  { name: '钢铁要塞', r: 21, rows: [' @ @ @ ', '#######', '# @ @ #', '#######'] },
]
let sgLevel = 1      // 当前关卡（1 起）
let sgAmmo = 0       // 本关剩余弹药（发射次数）
let sgCycle = 0      // 已通关轮数，每轮目标更小、弹药更紧、还会移动

// 命中判定留白：配合拉大的目标间距，让判定框彼此不重叠——一发只能打一个，
// 想连击必须靠精准穿过缝隙。之前 +24 时判定框比间距还大，飞一排必中一片。
const SG_HIT_PAD = 8
// 鱼身是有体积的（窗口内鱼身约 108×135px），碰撞不能再用"中心一个点"去撞。
// 否则鱼身边缘明明压到罐子了，中心点还差着 50~70px，判定不过——就是"看着碰到没碎"。
// 用贴合鱼身的矩形做"矩形-圆相交"判定：鱼身边缘碰到罐子圆即命中。
// 半宽/半高按真实鱼身包围盒取（素材 640×360 里鱼 x211~426/y61~330，缩放到 320×280 贴底）。
// 之前 46×52 偏小，鱼头/鱼尾擦到罐子时判定框还没到，导致"有的罐子看着碰到却没碎"。
const SG_FISH_HW = 56  // 鱼身碰撞半宽（真实约54，取56贴合）
const SG_FISH_HH = 68  // 鱼身碰撞半高（真实约67，取68贴合）
const SG_SHOT_HIT_CAP = 3 // 每发最多碎 3 个罐：保证连击手感，又不至于一发清空整塔

// 弹弓模式物理顶边上移量：让鱼能飞到屏幕上方一点去够高处罐塔，
// 但仍保留反弹（窗口不会被 macOS 钳制在屏幕边缘卡死）。
const SG_CEIL_RAISE = 130

// 关卡配置：超过模板数后循环，按轮次明显加难度。
// - 弹药 = 目标数的 75%（要求命中率），每轮再 -1
// - 半径每轮 -3px（肉眼可见地变小）
// - 第 2 轮起目标左右/上下摆动 = 移动靶，这是最能感知到的难度升级
function levelSpec(level) {
  const idx = (level - 1) % SG_LEVELS.length
  const cycle = Math.floor((level - 1) / SG_LEVELS.length)
  const base = SG_LEVELS[idx]
  const count = (base.rows.join('').match(/[#@]/g) || []).length
  return {
    name: base.name,
    count,
    ammo: Math.max(3, Math.ceil(count * 0.75) - cycle),
    r: Math.max(10, base.r - cycle * 3),
    rows: base.rows,
    cycle,
    moving: cycle > 0,
  }
}

function stopSgAnim() {
  if (sgAnimTimer) {
    clearInterval(sgAnimTimer)
    sgAnimTimer = null
  }
}

// 移动靶动画：每帧按正弦更新目标 x（碰撞判定读的就是这个实时 x），
// 并把最新坐标发给目标层重绘。只有存在 swayAmp>0 的目标时才跑。
function startSgAnim() {
  stopSgAnim()
  if (!sgTargets.some((t) => t.swayAmp > 0)) return
  sgAnimT0 = Date.now()
  sgAnimTimer = setInterval(() => {
    if (!slingshotMode || !targetWin || targetWin.isDestroyed()) return
    const tsec = (Date.now() - sgAnimT0) / 1000
    const moves = []
    for (const t of sgTargets) {
      if (!t.alive || !t.swayAmp) continue
      t.x = Math.round(t.baseX + Math.sin(tsec * t.swaySpeed + t.swayPhase) * t.swayAmp)
      // 夹在工作区内，别摆出屏幕
      t.x = Math.max(sgArea.x + t.r + 4, Math.min(sgArea.x + sgArea.width - t.r - 4, t.x))
      moves.push({ id: t.id, x: t.x - sgArea.x, y: t.y - sgArea.y })
    }
    if (moves.length && targetWin && !targetWin.isDestroyed()) {
      try { targetWin.webContents.send('sg:move', { moves }) } catch {}
    }
  }, 16)
}

function closeTargetLayer() {
  stopSgAnim()
  // 退出弹弓：恢复鱼窗口鼠标（按用户设置的穿透偏好），结束按钮不再需要
  if (win && !win.isDestroyed()) {
    try { applyClickThrough() } catch {}
  }
  if (targetWin && !targetWin.isDestroyed()) {
    try { targetWin.webContents.send('sg:bye') } catch {}
    try { targetWin.close() } catch {}
  }
  targetWin = null
  sgTargets = []
  sgArea = null
  sgLaunch = null
  // 鱼回到进入弹弓模式前的位置（落地归位把位置记成了发射台，这里必须还原并落盘）
  if (sgOrigBounds && win && !win.isDestroyed()) {
    try { win.setBounds(sgOrigBounds) } catch {}
    persistPosition()
  }
  sgOrigBounds = null
}

// 经典愤怒小鸟排版：弹弓（鱼）在屏幕左侧，罐子塔铺在右侧。
// 鱼往左下（或左）拉 → 往右上弹 → 打右边的罐子。
// 按当前关卡的格子图案生成目标；'@' 为装甲罐（hp=2，打两次才碎）。
function makeTargets(launch, area, level) {
  const spec = levelSpec(level || 1)
  const rows = spec.rows
  const r = spec.r
  const maxCols = Math.max(...rows.map((s) => s.length))
  // 间距必须 > 判定框直径(2*(r+SG_HIT_PAD))，否则判定框重叠→一发多杀。
  const gapX = Math.max(90, 2 * (r + SG_HIT_PAD) + 34)
  const gapY = Math.max(86, 2 * (r + SG_HIT_PAD) + 30)
  // 塔铺在屏幕右侧：整体中心放在工作区 62% 处
  const centerX = area.x + area.width * 0.62
  const fishBodyY = launch.y + launch.h * 0.68
  // 底排比鱼身体略高，保证往右上弹能打到；整塔高度往上长
  const bottomY = Math.max(area.y + 40 + (rows.length - 1) * gapY, Math.round(fishBodyY - 70))
  const list = []
  for (let row = 0; row < rows.length; row++) {
    const line = rows[row]
    const y = Math.round(bottomY - (rows.length - 1 - row) * gapY)
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      if (ch !== '#' && ch !== '@') continue
      const armor = ch === '@'
      // 移动靶：第 2 轮起，目标围绕基准位置左右摆（幅度随轮次增大），相位错开
      const swayAmp = spec.moving ? Math.min(110, 34 + spec.cycle * 22) : 0
      const swaySpeed = 0.9 + (c % 3) * 0.22 + row * 0.12
      const swayPhase = (c * 1.3 + row * 0.9) % (Math.PI * 2)
      list.push({
        id: ++targetSeq,
        x: Math.round(centerX + (c - (maxCols - 1) / 2) * gapX),
        y,
        baseX: Math.round(centerX + (c - (maxCols - 1) / 2) * gapX),
        swayAmp,
        swaySpeed,
        swayPhase,
        r,
        pts: 1 + (rows.length - 1 - row) + (armor ? 2 : 0), // 越高越值钱，装甲额外加分
        hp: armor ? 2 : 1,
        maxHp: armor ? 2 : 1, // 目标层据此画护盾环/裂纹，缺失会让装甲罐被当成普通罐
        alive: true,
      })
    }
  }
  return list
}

function openTargetLayer() {
  closeTargetLayer()
  if (!win || win.isDestroyed()) return
  const disp = screen.getDisplayMatching(win.getBounds())
  const wa = disp.workArea
  sgArea = { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
  sgScore = 0
  sgLevel = 1
  sgCycle = 0

  // 经典排版：把鱼挪到屏幕左侧中部当弹弓，记下原位，退出弹弓模式时还回去
  const origin = win.getBounds()
  sgOrigBounds = { x: origin.x, y: origin.y, width: origin.width, height: origin.height }
  const launchX = Math.round(wa.x + Math.max(40, wa.width * 0.06))
  const launchY = Math.round(wa.y + wa.height * 0.46 - origin.height * 0.68)
  sgLaunch = { x: launchX, y: launchY, w: origin.width, h: origin.height }
  try { win.setBounds({ x: launchX, y: launchY, width: origin.width, height: origin.height }) } catch {}

  sgTargets = makeTargets(sgLaunch, sgArea, sgLevel)
  sgAmmo = levelSpec(sgLevel).ammo

  targetWin = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'target-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 输入屏障：目标层全屏覆盖工作区、接收鼠标、置于最上层。弹弓期间所有鼠标
  // 都会被它吃掉，绝不会穿透误触下层应用；拖拽事件由它经 IPC 转给鱼的弹弓逻辑。
  // 同时让鱼窗口鼠标穿透（它在屏障下面，反正也收不到），退出时再恢复。
  targetWin.setIgnoreMouseEvents(false)
  targetWin.setAlwaysOnTop(true, 'floating')
  targetWin.loadFile(path.join(__dirname, '..', 'renderer', 'targets.html'))
  targetWin.webContents.once('did-finish-load', () => {
    sendTargets()
    startSgAnim()
  })
  targetWin.on('closed', () => { targetWin = null })
  if (win && !win.isDestroyed()) {
    try { win.setIgnoreMouseEvents(true, { forward: false }) } catch {}
  }
}

function sendTargets() {
  if (!targetWin || targetWin.isDestroyed()) return
  // 转成相对目标层窗口的坐标给渲染层画
  const spec = levelSpec(sgLevel)
  const rel = sgTargets.map((t) => ({
    id: t.id,
    x: t.x - sgArea.x,
    y: t.y - sgArea.y,
    r: t.r,
    pts: t.pts,
    hp: t.hp,
    maxHp: t.maxHp,
    alive: t.alive,
  }))
  targetWin.webContents.send('sg:init', {
    width: sgArea.width,
    height: sgArea.height,
    targets: rel,
    score: sgScore,
    level: sgLevel,
    name: spec.name,
    ammo: sgAmmo,
    cycle: spec.cycle,
    moving: spec.moving,
    // 鱼窗口鼠标穿透后，鱼头 HUD 上的"结束✕"点不到，把可点的结束按钮交给
    // 屏障层渲染，并告诉它鱼头顶在哪（发射台左上 + 半宽，转目标层相对坐标）。
    quitBtn: sgLaunch
      ? { x: Math.round(sgLaunch.x + sgLaunch.w / 2 - sgArea.x), y: Math.round(sgLaunch.y - sgArea.y - 12) }
      : null,
  })
  // 同步关卡信息给桌宠 HUD
  if (win && !win.isDestroyed()) {
    win.webContents.send('sg:level', { level: sgLevel, name: spec.name, ammo: sgAmmo, score: sgScore })
  }
}

// 发射后只更新弹药数，不重铺目标
function sendAmmo() {
  if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send('sg:ammo', { ammo: sgAmmo })
  if (win && !win.isDestroyed()) win.webContents.send('sg:level', {
    level: sgLevel,
    name: levelSpec(sgLevel).name,
    ammo: sgAmmo,
    score: sgScore,
  })
}

// 鱼身(矩形 AABB) 与罐子(圆) 是否相交——纯函数，供判定与自检共用。
// 取鱼身矩形到罐子圆心的最近距离，小于等效半径即命中。用整条鱼的身体去撞，
// 而不是拿中心一个点；这样鱼身边缘压到罐子就算数，符合你眼睛看到的接触。
function fishBodyHitsTarget(fishX, fishY, t) {
  const dx = Math.max(Math.abs(fishX - t.x) - SG_FISH_HW, 0)
  const dy = Math.max(Math.abs(fishY - t.y) - SG_FISH_HH, 0)
  const reach = t.r + SG_HIT_PAD
  return dx * dx + dy * dy < reach * reach
}

// 扫掠判定：沿"上一帧中心 → 当前帧中心"的线段密集采样，任一采样点鱼身碰到罐子即命中。
// 力度加大后单帧可移动 40px+，只看当前一个点会隧穿漏撞（"明明穿过却没碎"）。
// 采样步长 10px，远小于鱼身判定框，密集到不会漏。prev 为空（首帧）时退化为单点判定。
function fishSweepHitsTarget(fishX, fishY, prevX, prevY, t) {
  if (prevX == null || prevY == null) return fishBodyHitsTarget(fishX, fishY, t)
  const dist = Math.hypot(fishX - prevX, fishY - prevY)
  const steps = Math.max(1, Math.ceil(dist / 10))
  for (let i = 0; i <= steps; i++) {
    const k = i / steps
    const sx = prevX + (fishX - prevX) * k
    const sy = prevY + (fishY - prevY) * k
    if (fishBodyHitsTarget(sx, sy, t)) return true
  }
  return false
}

// 鱼飞行每帧调用：鱼身矩形是否撞到活目标圆。
// fishX/fishY 是鱼身中心（flight 左上角 + 半宽/0.68 高），与瞄准弹道同一基准。
function checkTargetHits(fishX, fishY, prevX, prevY) {
  if (!slingshotMode || !sgTargets.length) return
  // 每发命中上限：不再用时间冷却（力度加大后一发穿塔很快，时间冷却会让接连
  // 碰到的罐子被忽略=看着碰到没碎）。改成按"本发已碎个数"限制，碎够上限这发
  // 就不再计数——既保证每个明显接触都碎，又不会一发横扫整塔。
  if (sgShotHits >= SG_SHOT_HIT_CAP) return
  // 撞击方向（鱼当前速度归一化）：给目标层做方向性碎片飞溅，碎片顺着鱼撞过去的方向喷。
  let dirX = 1, dirY = -0.4
  if (flight && (flight.vx || flight.vy)) {
    const sp = Math.hypot(flight.vx, flight.vy) || 1
    dirX = flight.vx / sp
    dirY = flight.vy / sp
  }
  for (const t of sgTargets) {
    if (!t.alive) continue
    if (fishSweepHitsTarget(fishX, fishY, prevX, prevY, t)) {
      sgShotHits += 1
      // 装甲罐：第一发只掉血、不消失，给受击反馈；第二发才碎
      if (t.hp > 1) {
        t.hp -= 1
        const crack = { id: t.id, x: t.x - sgArea.x, y: t.y - sgArea.y, hp: t.hp, cracked: true, dirX, dirY }
        if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send('sg:hit', crack)
        if (win && !win.isDestroyed()) win.webContents.send('pet:armor-hit')
        break
      }
      t.alive = false
      sgScore += t.pts * 10
      const d = { id: t.id, x: t.x - sgArea.x, y: t.y - sgArea.y, pts: t.pts * 10, score: sgScore, hp: 0, dirX, dirY }
      if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send('sg:hit', d)
      if (win && !win.isDestroyed()) {
        win.webContents.send('sg:score', { score: sgScore, x: t.x, y: t.y, pts: t.pts * 10 })
        win.webContents.send('pet:target-hit')
      }
      // 本关全清 → 过关
      if (sgTargets.every((x) => !x.alive)) onLevelClear()
      break // 一帧最多撞一个
    }
  }
}

// 关卡流转：过关 / 弹药耗尽重来，都先归位到发射台，短暂展示结果再铺下一局。
let sgTransition = false
function onLevelClear() {
  if (sgTransition || !slingshotMode) return
  sgTransition = true
  const cleared = sgLevel
  sgLevel += 1
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.webContents.send('sg:clear', { score: sgScore, level: cleared, next: sgLevel, pass: true })
  }
  if (win && !win.isDestroyed()) win.webContents.send('sg:clear', { score: sgScore })
  setTimeout(() => {
    if (!slingshotMode || !sgLaunch) { sgTransition = false; return }
    try { win.setPosition(sgLaunch.x, sgLaunch.y) } catch {}
    nextLevel()
    sgTransition = false
  }, 1800)
}

function onLevelFail() {
  if (sgTransition || !slingshotMode) return
  sgTransition = true
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.webContents.send('sg:clear', { score: sgScore, level: sgLevel, next: sgLevel, pass: false })
  }
  if (win && !win.isDestroyed()) win.webContents.send('sg:fail', { level: sgLevel })
  setTimeout(() => {
    if (!slingshotMode || !sgLaunch) { sgTransition = false; return }
    try { win.setPosition(sgLaunch.x, sgLaunch.y) } catch {}
    nextLevel()
    sgTransition = false
  }, 1800)
}

function nextLevel() {
  const spec = levelSpec(sgLevel)
  sgCycle = spec.cycle
  sgTargets = makeTargets(sgLaunch, sgArea, sgLevel)
  sgAmmo = spec.ammo
  sendTargets()
  startSgAnim() // 新一轮可能有移动靶，重启动画
  if (win && !win.isDestroyed()) win.webContents.send('sg:respawn')
}

// 气泡菜单单个动作的分发。渲染层只发动作名，具体逻辑都在主进程，跟原生菜单共用一套函数。
function dispatchMenuAction(action) {
  switch (action) {
    case 'chat':
      openChatWindow()
      break
    case 'poke':
      if (win && !win.isDestroyed()) win.webContents.send('pet:poke')
      break
    case 'rps':
      doRps(null) // 气泡里点一下 = 随机出一只手
      break
    case 'note':
      doNote()
      break
    case 'feed':
      doFeed()
      break
    case 'speak':
      speakNow()
      break
    case 'crawl':
      toggleCrawl()
      break
    case 'sound':
      cycleSound()
      break
    case 'clickSfx':
      toggleClickSfx()
      break
    case 'clickThrough':
      toggleClickThrough()
      break
    case 'reset':
      stopCrawlIfOn()
      resetPosition()
      break
    case 'reload':
      reloadConfig()
      break
    case 'audition':
      openAudition()
      break
    case 'openWorkBuddy':
      openTool('workbuddy')
      break
    case 'openCursor':
      openTool('cursor')
      break
    case 'openCwdCursor':
      openTool('cwd-cursor')
      break
    case 'openCwdTerminal':
      openTool('cwd-terminal')
      break
    case 'openCwdFinder':
      openTool('cwd-finder')
      break
    case 'digest':
      sayDigest()
      break
    case 'replayEvolve':
      fireEvolve(evolve.replay(cfg))
      break
    case 'game':
      // 进入/退出弹弓发射器模式：弹射的就是这只真窗，不扩窗。切模式时停巡游。
      stopCrawlIfOn()
      slingshotMode = !slingshotMode
      if (slingshotMode) openTargetLayer()
      else closeTargetLayer()
      if (win && !win.isDestroyed()) win.webContents.send('pet:open-game', { on: slingshotMode })
      break
    case 'quit':
      app.quit()
      return
    default:
      if (!MENU_ACTIONS.includes(action)) console.warn('[pet] 未知菜单动作：', action)
      break
  }
}

// resetPosition 自己会 stopCrawl，这里只是显式表达意图，留个空壳便于阅读
function stopCrawlIfOn() {
  if (crawlerOn) stopCrawl()
}

// 气泡菜单「更多」子页的数据。同步生成，渲染层拿去分组渲染。
// 结构：groups[] = { title, items:[{ico, txt, hint, action?, readonly?}] }
function buildActionMenuData() {
  const groups = []

  // 状态（只读信息行）
  const status = []
  const moodS = mood.snapshot(cfg)
  if (moodS.enabled) {
    const label = { happy: '开心', calm: '平静', sad: '有点蔫' }[moodS.mood] || moodS.mood
    status.push({ ico: '💗', tint: '#e0679a', txt: `心情：${label}${moodS.sulking ? '（赌气中）' : ''}`, readonly: true })
    if (moodS.bond != null)
      status.push({ ico: '💞', tint: '#e0679a', txt: `亲密度 ${moodS.bond}%${moodS.level ? ' · ' + moodS.level.label : ''}`, readonly: true })
  }
  const fullnessV = feed.fullness(cfg)
  if (fullnessV != null) status.push({ ico: '🍚', tint: '#4c9e6a', txt: `饱腹度 ${Math.round(fullnessV)}%`, readonly: true })
  const coinS = coins.snapshot(cfg)
  if (coinS.enabled) status.push({ ico: '🪙', tint: '#b8860b', txt: `小金库 ${coinS.total} 枚${coinS.tier ? ' · ' + coinS.tier.label : ''}`, readonly: true })
  const evS = evolve.snapshot(cfg)
  if (evS.enabled && evS.total) status.push({ ico: '🦋', tint: '#7b6cd4', txt: `形态 ${evS.formLabel}（${evS.unlocked}/${evS.total}）`, readonly: true })
  const achS = achieve.snapshot(cfg)
  if (achS.enabled && achS.total) status.push({ ico: '🏅', tint: '#e08a3c', txt: `成就 ${achS.done}/${achS.total}`, readonly: true })
  if (status.length) groups.push({ title: '它现在的状态', icon: '📊', tint: '#4c9e6a', layout: 'grid', items: status })

  // 查看 / 回看
  const view = []
  const dig = digest.today(cfg)
  if (dig) view.push({ ico: '📰', tint: '#378add', txt: '今天干了啥', hint: '念战报', action: 'digest' })
  if (evS.enabled && evS.unlocked) view.push({ ico: '👀', tint: '#7b6cd4', txt: '回看当前形态', action: 'replayEvolve' })
  if (view.length) groups.push({ title: '看看', icon: '👀', tint: '#7b6cd4', layout: 'grid', items: view })

  // 打开工具
  const open = [
    { ico: '🐟', tint: '#378add', txt: '打开 WorkBuddy', action: 'openWorkBuddy' },
    { ico: '🧭', tint: '#7b6cd4', txt: '打开 Cursor', action: 'openCursor' },
  ]
  if (currentCwd()) {
    open.push({ ico: '💻', tint: '#4c9e6a', txt: '用 Cursor 打开当前项目', action: 'openCwdCursor' })
    open.push({ ico: '⌨️', tint: '#2a9d8f', txt: '在终端打开当前项目', action: 'openCwdTerminal' })
    open.push({ ico: '📂', tint: '#e08a3c', txt: '在访达中显示当前项目', action: 'openCwdFinder' })
  }
  groups.push({ title: '打开', icon: '🚀', tint: '#378add', layout: 'grid', items: open })

  // 设置
  const setting = [
    { ico: '🔊', tint: '#378add', txt: soundMenuLabel(), hint: '点一下切换', action: 'sound' },
  ]
  if (sfx.auditionPath()) setting.push({ ico: '🎵', tint: '#7b6cd4', txt: '挑语音音色…', hint: '试听', action: 'audition' })
  if (sfx.clickAvailable()) setting.push({ ico: '👆', tint: '#e0679a', txt: clickMenuLabel(), hint: '开关', action: 'clickSfx' })
  setting.push({ ico: '🪟', tint: '#7d8a99', txt: clickThroughLabel(), hint: '开关', action: 'clickThrough' })
  setting.push({ ico: '📍', tint: '#2a9d8f', txt: '回到屏幕右下角', action: 'reset' })
  setting.push({ ico: '🔄', tint: '#7d8a99', txt: '重载配置', action: 'reload' })
  groups.push({ title: '设置', icon: '🎛️', tint: '#7d8a99', layout: 'grid', items: setting })

  groups.push({ title: '', icon: '🚪', tint: '#c0392b', layout: 'grid', items: [{ ico: '🚪', tint: '#c0392b', txt: '退出', action: 'quit', danger: true }] })
  return groups
}

let lastCwd = ''
function currentCwd() {
  return lastCwd
}

function labelOf(phase) {
  const m = { idle: '摸鱼中', thinking: '思考', working: '工作中', organizing: '整理', waiting: '等你', success: '搞定', error: '出错' }
  return m[phase] || phase
}

// 「它在干嘛？」：不受 poll 去重影响，先当场探一次，探不到就用上次记住的。
// 关键是给它一句**专属汇报台词**——早先复用 onState(force)，idle 时反而把气泡
// 藏了、忙碌时又显示原来那句，用户点下去几乎看不出变化，等于没反应。
function speakNow() {
  if (!watcher) return
  Promise.resolve()
    .then(() => watcher.poll())
    .then((s) => {
      const cur = s || lastKnown
      const line = reportLine(cfg, cur)
      const anim = pick(((cfg.speak || {}).anims) || [])
      win.webContents.send('pet:speak', {
        line,
        anim,
        source: cur.source,
        phase: cur.phase,
        title: cur.title,
        project: cur.project,
      })
      if (line) sfx.speakText(cfg, line)
    })
    .catch(() => {
      // 探测异常也不能让它沉默，至少用上次状态报一句
      const line = reportLine(cfg, lastKnown)
      win.webContents.send('pet:speak', { line, anim: pick(((cfg.speak || {}).anims) || []) })
      if (line) sfx.speakText(cfg, line)
    })
}

// 把当前状态拼成一句"汇报"。idle 和忙碌各用一池，忙碌的台词带 agent/档位/问题占位符。
// 抽成纯函数好自检——用户抱怨"没反应"时，能直接验证这个函数一定吐出非空台词。
function reportLine(cfg, cur) {
  const sc = (cfg && cfg.speak) || {}
  const c = cur || {}
  const ph = c.phase || 'idle'
  const ag = ((cfg && cfg.agents) || {})[c.source]
  const agLabel = ag && ag.label ? ag.label : ''
  const phaseLabel = (((cfg && cfg.phases) || {})[ph] || {}).label || ph
  const what = String(c.title || c.project || '').trim()
  if (ph === 'idle') return String(pick(sc.idleLines) || '现在没在忙，我摸鱼呢~')
  return String(pick(sc.busyLines) || '{agent}正在{phase}，我盯着呢~')
    .replace('{agent}', agLabel || '它')
    .replace('{phase}', phaseLabel)
    .replace('{what}', what ? '：' + what : '')
}

function resetPosition() {
  if (crawlerOn) stopCrawl()
  const wa = screen.getDisplayMatching(win.getBounds()).workArea
  win.setPosition(wa.x + wa.width - win.getBounds().width - 48, wa.y + wa.height - win.getBounds().height - 12)
  persistPosition()
}

// 亲密度：戳一下 / 喂一口都涨一点，并把「上次互动时间」刷新（衰减从头算）
function bumpBond(kind) {
  mood.bumpBond(cfg, kind)
  pushMood()
  checkAchievements() // 亲密度可能刚好到 100
  checkEvolve() // 亲密度也可能刚好跨到下一个形态
}

// 心情快照变了才推。亲密度是按时间戳现算的，每秒推一次纯属浪费
let lastMoodJson = ''
function pushMood() {
  if (!win) return
  const snap = mood.snapshot(cfg)
  const j = JSON.stringify(snap)
  if (j === lastMoodJson) return
  lastMoodJson = j
  win.webContents.send('pet:mood', snap)
}

// 「一起躺平」和「卡太久」都只在三家各自的轮询结果上判断，不打断正在播的状态动画
function applyMood(all) {
  if (!win || win.isDestroyed()) return
  const m = cfg.mood || {}
  if (m.enabled === false) return
  const w = mood.watch(cfg, all, Date.now())
  const lines = m.lines || {}

  if (w.lieDown) {
    win.webContents.send('pet:liedown', {
      anim: pick((m.anims || {}).lieDown) || '原地小憩沉眠',
      line: pick(lines.lieDown) || '',
    })
  }
  if (w.stuck) {
    const tpl = lines.stuck || '{agent}这一轮跑了 {min} 分钟了，要不要看看'
    const line = String(tpl)
      .replace('{agent}', `${agentOf(w.stuck.source).label} `)
      .replace('{min}', String(w.stuck.minutes))
    win.webContents.send('pet:stuck', {
      line,
      source: w.stuck.source,
      what: w.stuck.what,
      minutes: w.stuck.minutes,
    })
  }
}

// 作息动画：早上刷牙 / 深夜打瞌睡 / 久坐伸懒腰 / 摸鱼时自己玩
function applyRoutine(all, now) {
  if (!win || win.isDestroyed()) return
  const r = routine.watch(cfg, all, now)
  if (r) win.webContents.send('pet:routine', r)
}

// 冷落太久，它主动来引起你注意（敲桌子 / 吐泡泡）
function applyLonely(all, now) {
  if (!win || win.isDestroyed()) return
  const l = lonely.watch(cfg, all, now)
  if (l) {
    win.webContents.send('pet:lonely', l)
    if (l.line) sfx.speakText(cfg, l.line)
  }
}

// 你在忙的时候，隔一阵子递一张关怀小纸条（便签样式）
function applyNote(all, now) {
  if (!win || win.isDestroyed()) return
  const d = note.watch(cfg, all, now)
  if (d) win.webContents.send('pet:note', d)
}

// 今天过不过节。一天只会变一次，所以按日期缓存，变了才推给渲染层
let occasionDay = ''
function applyOccasion(now) {
  const key = new Date(now).toDateString()
  if (key === occasionDay) return
  occasionDay = key
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:occasion', calendar.occasionOf(cfg, new Date(now)))
}

function pushState(s, force) {
  lastKnown = {
    phase: s.phase,
    project: s.project,
    detail: s.detail,
    source: s.source,
    title: s.title || '',
    cwd: s.cwd || '',
    // steps.enabled=false 就不显示"每一步"，只留档位
    step: stepsOn() ? s.step || '' : '',
    steps: stepsOn() && Array.isArray(s.steps) ? s.steps.slice(0, 12) : [],
  }
  if (s.cwd) lastCwd = s.cwd
  // 托盘悬停也能一眼看出是哪个 agent 在处理哪个问题
  if (tray) {
    const w = whatOf(lastKnown)
    tray.setToolTip(
      `大肥鱼 · ${agentOf(lastKnown.source).label}：${labelOf(lastKnown.phase)}${w ? ' · ' + w : ''}`
    )
  }
  // 状态一变就给一声提示音（渲染层不管，直接用系统播放器，窗口没焦点也响）
  try {
    sfx.play(cfg, s)
  } catch {
    /* 声音不是关键路径，出错也不能影响桌宠 */
  }
  // 成功/失败各记一笔流水，攒出心情（同一次结果只记一次，重复推送不会刷分）
  try {
    if (mood.note(cfg, s.phase)) {
      // 同一次结果喂给三个账本：心情（最近 30 分钟）、小金库（累计）、每日回顾（按天）
      const c = coins.note(cfg, s.phase)
      if (c && c.gift) {
        const cs = cfg.coins || {}
        win.webContents.send('pet:gift', {
          anim: pick(cs.giftAnims) || '拆礼物',
          line: pick(((cs.lines) || {}).gift) || '',
          total: c.total,
        })
      }
      digest.note(cfg, s.phase, s.project || s.title)
      checkAchievements()
    }
    pushMood()
  } catch {
    /* 心情不是关键路径 */
  }
  win.webContents.send('pet:state', Object.assign({}, s, { force: !!force }))
}

app.whenReady().then(() => {
  cfg = loadConfig()
  sfx.warmup(cfg) // 异步探一次 python，别等到第一次播报才同步阻塞

  protocol.handle('pet', async (req) => {
    try {
      const name = decodeURIComponent(req.url.replace(/^pet:\/*/i, ''))
      const file = path.join(ASSETS_DIR, 'webm', name)
      const buf = await fs.promises.readFile(file)
      return new Response(buf, { headers: { 'Content-Type': 'video/webm' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  createWindow()

  // 羁绊进化：开机静默同步已解锁档，避免每次启动都弹演出。
  // 但全新安装（seen 为空）时亮一次相，好让这个新功能能被发现。
  // 自检模式不写存档也不演出，免得污染真实进度和 probe。
  if (!SELFTEST) {
    const evolveFresh = evolve.fresh(cfg)
    evolve.check(cfg, { silent: true })
    if (evolveFresh) setTimeout(() => fireEvolve(evolve.replay(cfg)), 4500)
    // 上次开着巡游就接着爬；等渲染层就位再启动，免得第一条 crawl 事件丢掉
    if (cfg.crawler && cfg.crawler.on) setTimeout(() => { if (!crawlerOn) startCrawl() }, 1500)
  }

  ipcMain.handle('pet:boot', () => {
    const assets = listAssets()
    pools = classify(assets, cfg)
    return {
      config: cfg,
      assets,
      pools,
      root: ROOT,
      fullness: feed.fullness(cfg),
      mood: mood.snapshot(cfg),
      occasion: calendar.occasionOf(cfg),
      clickThrough: !!cfg.pet.clickThrough,
      coins: coins.snapshot(cfg),
      digest: digest.today(cfg),
      selftest: SELFTEST,
    }
  })

  // Retina 下 movementX/Y 是小数（如 -8.5），setPosition 只接受整数，
  // 直接传会抛 "conversion failure from"。统一取整 + 校验。
  ipcMain.on('pet:move-by', (_e, rawDx, rawDy) => {
    const dx = Number(rawDx)
    const dy = Number(rawDy)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    if (crawlerOn) stopCrawl() // 用户开始拖 = 手动接管，停下巡游
    stopFlight()
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  ipcMain.on('pet:throw', (_e, rawVx, rawVy) => {
    const vx = Number(rawVx)
    const vy = Number(rawVy)
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return
    if (!win || win.isDestroyed()) return
    startFlight(vx, vy)
  })

  // 弹弓瞄准弹道：渲染层给的是相对桌宠窗口的抛物线点，换算成目标层坐标后转发。
  ipcMain.on('pet:sg-aim', (_e, pts) => {
    if (!slingshotMode || !win || win.isDestroyed()) return
    if (!targetWin || targetWin.isDestroyed() || !sgArea || !Array.isArray(pts)) return
    const b = win.getBounds()
    const rel = pts.map((p) => ({
      x: Math.round(p.x + b.x - sgArea.x),
      y: Math.round(p.y + b.y - sgArea.y),
    }))
    try { targetWin.webContents.send('sg:aim', { points: rel }) } catch {}
  })
  ipcMain.on('pet:sg-aim-clear', () => {
    if (targetWin && !targetWin.isDestroyed()) {
      try { targetWin.webContents.send('sg:aim-clear') } catch {}
    }
  })

  // 输入屏障（全屏目标层）接手的拖拽事件转发给鱼的弹弓逻辑。
  // 屏障坐标相对 workArea（=sgArea 原点），转成鱼窗口内 client 坐标。
  const relayBarrier = (channel, d) => {
    if (!slingshotMode || !win || win.isDestroyed() || !d) return
    const b = win.getBounds()
    const origin = sgArea || { x: 0, y: 0 }
    win.webContents.send(channel, {
      x: Number(d.x) + origin.x - b.x,
      y: Number(d.y) + origin.y - b.y,
    })
  }
  ipcMain.on('sg:barrier-down', (_e, d) => relayBarrier('pet:barrier-down', d))
  ipcMain.on('sg:barrier-move', (_e, d) => relayBarrier('pet:barrier-move', d))
  ipcMain.on('sg:barrier-up', (_e, d) => relayBarrier('pet:barrier-up', d))
  // 屏障层"结束游戏"按钮：关闭弹弓模式并归位
  ipcMain.on('sg:quit', () => {
    if (!slingshotMode) return
    stopFlight()
    slingshotMode = false
    closeTargetLayer()
    if (win && !win.isDestroyed()) win.webContents.send('pet:open-game', { on: false })
  })

  ipcMain.on('pet:walk', (_e, dist, ms) => startWalk(Number(dist) || 0, Number(ms) || 2600))
  // 右键菜单曾因 label 传了 Promise 而整体弹不出来，且异常被静默吞掉。
  // 自检收尾前先真实构建一次菜单模板，把这类回归挡在提交之前。
  ipcMain.on('pet:selftest', (_e, data) => {
    if (!SELFTEST) return
    const finish = (extra) => selftestDone(Object.assign({}, data, extra))
    const guard = new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))
    Promise.race([buildMenuTemplate(), guard])
      .then((tpl) => {
        if (!tpl || !tpl.items) return finish({ menuBuilt: false, menuError: '菜单构建超时/无结果' })
        const bad = []
        const labels = []
        const walk = (items) => {
          for (const it of items || []) {
            if (it.label != null && typeof it.label !== 'string') bad.push(String(it.label))
            if (typeof it.label === 'string') labels.push(it.label)
            walk(it.submenu && it.submenu.items)
          }
        }
        walk(tpl.items)
        // 猜拳判定：三种互克 + 平局都要对
        const rpsCheck = {
          石头剪刀: rpsDecide('石头', '剪刀') === 'win',
          剪刀布: rpsDecide('剪刀', '布') === 'win',
          布石头: rpsDecide('布', '石头') === 'win',
          石头石頭: rpsDecide('石头', '石头') === 'draw',
          石头布: rpsDecide('石头', '布') === 'lose',
        }
        // 递纸条判定：没在忙不递、没到间隔不递、到点了才递
        const ncfg = Object.assign({}, cfg, { note: { enabled: true, everyMs: 1000 } })
        const noteCheck = {
          idleBusy: note.shouldFire(ncfg, 0, false, 5000) === false,
          tooSoon: note.shouldFire(ncfg, 4500, true, 5000) === false,
          dueTime: note.shouldFire(ncfg, 3000, true, 5000) === true,
          firstTime: note.shouldFire(ncfg, 0, true, 5000) === true,
        }
        // 「它在干嘛？」汇报台词：idle 和忙碌都要非空，且忙碌时占位符要被替换掉
        const speakIdle = reportLine(cfg, { phase: 'idle', source: 'none' })
        const speakBusy = reportLine(cfg, {
          phase: 'working',
          source: 'cursor',
          title: '自检项目',
        })
        const speakCheck = {
          idleNonEmpty: !!speakIdle,
          busyNonEmpty: !!speakBusy,
          noPlaceholder: !/\{(agent|phase|what)\}/.test(speakBusy),
          hasAgent: /Cursor/.test(speakBusy),
        }
        // 菜单精简：顶层要短（≤15），三个分组都在，高频互动仍在顶层。
        // 防止以后往顶层堆功能又变回几十项的"臃肿菜单"。
        const topLabels = tpl.items.map((it) => it.label).filter((x) => typeof x === 'string')
        const layoutCheck = {
          topShort: tpl.items.length <= 16,
          hasGroups: ['状态', '打开', '设置'].every((g) => topLabels.includes(g)),
          coreOnTop: ['摸一下', '它在干嘛？'].every((g) => topLabels.includes(g)),
          chatOnTop: topLabels.some((x) => x && x.indexOf('聊聊') >= 0),
          crawlOnTop: topLabels.some((x) => x && x.indexOf('巡游') >= 0),
        }
        // 对话：意图命中 + 离线兜底 + 上下文替换。不依赖网络，纯函数断言。
        const cGreet = chat.matchIntent('你好呀')
        const cStatus = chat.offlineReply('你在干嘛', {
          agentLabel: 'WorkBuddy',
          phaseLabel: '工作中',
          what: '自检项目',
        })
        const cUnknown = chat.offlineReply('asdfghjkl随机乱码', {})
        const chatCheck = {
          greetHit: !!cGreet && cGreet.id === 'greet',
          jokeHit: (chat.matchIntent('讲个笑话') || {}).id === 'joke',
          statusFilled: !!cStatus.line && !/\{(agent|phase|what)\}/.test(cStatus.line),
          fallbackOk: !!cUnknown.line && !!cUnknown.anim,
          quickAsks: chat.quickAsks(cfg).length > 0,
        }
        // 羁绊进化：5 档形态配置齐全、文案占位符已替换、菜单里有形态入口。
        // 不依赖存档（自检不写 evolve.json），用 preview 直接造事件。
        const bondLevels = (cfg.bond || {}).levels || []
        const evolveForms = (cfg.evolve || {}).forms || {}
        const evLast = bondLevels.length
          ? evolve.preview(cfg, bondLevels[bondLevels.length - 1].key)
          : null
        const evCheck = {
          formsOk:
            bondLevels.length > 0 &&
            bondLevels.every((lv) => {
              const f = evolveForms[lv.key]
              return !!(
                f &&
                f.formLabel &&
                Array.isArray(f.anims) &&
                f.anims.length &&
                Array.isArray(f.lines) &&
                f.lines.length
              )
            }),
          fiveLevels: bondLevels.length === 5,
          lastFilled:
            !!evLast && !!evLast.line && !!evLast.anim && !/\{(agent|phase|what)\}/.test(evLast.line),
          menuShown: labels.some((x) => typeof x === 'string' && x.indexOf('形态：') >= 0),
          replayOk: !!evolve.replay(cfg),
        }
        // 桌面巡游行为状态机：漫步加减速、边缘转身、恒定贴底、鼠标多种互动、
        // 行为到期主动切换、驻足速度为 0——全用纯函数 + 固定输入验，不启动定时器。
        const cBounds = {
          x: 0,
          y: 0,
          width: 1000,
          height: 700,
          floorY: 640,
          w: 320,
          h: 280,
        }
        // 漫步：vx 从 0 缓动加速，鱼往前走；驻足行为 vx 应为 0
        let cs = crawl.create(500, 640, 100, 1)
        cs.behaviorUntil = 999999
        for (let i = 0; i < 10; i++) crawl.step(cs, 0, cBounds, null, 100 + i * 33)
        const cWalk = cs.x > 500 && cs.vx > 0 && cs.activity === 'walk'
        cs.activity = 'look'
        cs.vx = 1.5
        const xBeforePause = cs.x
        crawl.step(cs, 0, cBounds, null, 500)
        // 静止类行为必须「立刻停住」：vx 归零、坐标不再滑，
        // 才能和渲染层同一帧切到的静止动画严格同步。
        const cPauseVx = cs.vx === 0 && cs.x === xBeforePause
        // 边缘转身
        cs = crawl.create(500, 640, 200, 1)
        cs.behaviorUntil = 999999
        cs.x = 1000
        cs.dir = 1
        cs.pauseUntil = 0
        crawl.step(cs, 0, cBounds, null, 200)
        const cTurn = cs.dir === -1 && cs.x <= 1000
        // 恒定贴底：从高处起步会平滑靠拢 floorY，不会爬边缘/翻到顶部
        cs = crawl.create(500, 100, 300, 1)
        cs.behaviorUntil = 999999
        for (let i = 0; i < 30; i++) crawl.step(cs, 0, cBounds, null, 300 + i * 33)
        const cFloor = cs.y > 100 && Math.abs(cs.y - cBounds.floorY) < 1
        // 鼠标靠近触发俏皮互动，且三种反应都合法
        const cCenter = crawl.center(cs, cBounds)
        const reactKinds = new Set()
        for (let i = 0; i < 30; i++) {
          const t = crawl.create(500, 640, 100, 1)
          t.behaviorUntil = 999999
          crawl.step(t, 0, cBounds, { x: cCenter.x + 20, y: cCenter.y }, 100)
          reactKinds.add(t.activity)
        }
        const cReact = ['shy', 'greet', 'flee'].every((k) => reactKinds.has(k))
        // 短反应到期会回漫步
        cs = crawl.create(500, 640, 100, 1)
        crawl.react(cs, 'shy', 100)
        crawl.step(cs, 0, cBounds, null, 100 + crawl.REACT_COOLDOWN + 500)
        const cRecover = cs.activity === 'walk'
        // 每种行为的动画 + 台词都要配齐，用户才看得出「在干嘛」
        const actKeys = ['walk', 'run', 'look', 'stretch', 'shy', 'greet', 'flee']
        const acts = ((cfg.crawler || {}).activities) || {}
        const actsOk = actKeys.every(
          (k) => acts[k] && (acts[k].anims || []).length && (acts[k].lines || []).length
        )
        const crawlCheck = {
          walk: cWalk,
          pauseVx: cPauseVx,
          turn: cTurn,
          floor: cFloor,
          react: cReact,
          recover: cRecover,
          actsOk,
        }
        finish({
          menuBuilt: true,
          menuItems: tpl.items.length,
          menuTopLabels: topLabels,
          menuLayoutOk: Object.values(layoutCheck).every(Boolean),
          menuLayoutCheck: layoutCheck,
          menuBadLabels: bad,
          speak: { idle: speakIdle, busy: speakBusy },
          speakAllOk: Object.values(speakCheck).every(Boolean),
          speakCheck,
          rps: rpsCheck,
          rpsAllOk: Object.values(rpsCheck).every(Boolean),
          noteMenuOk: labels.includes('递张小纸条'),
          note: noteCheck,
          noteAllOk: Object.values(noteCheck).every(Boolean),
          chat: { greet: cGreet && cGreet.id, status: cStatus.line, fallback: cUnknown.line },
          chatAllOk: Object.values(chatCheck).every(Boolean),
          chatCheck,
          evolveAllOk: Object.values(evCheck).every(Boolean),
          evolveCheck: evCheck,
          crawlAllOk: Object.values(crawlCheck).every(Boolean),
          crawlCheck,
          // 自绘气泡菜单：动作清单齐全 + 子页数据非空 + 分发器/扩窗函数就位
          menuActionOk:
            ['chat', 'poke', 'rps', 'note', 'feed', 'speak', 'crawl', 'sound', 'clickSfx', 'clickThrough', 'reset', 'reload', 'openWorkBuddy', 'digest', 'quit', 'game'].every(
              (a) => MENU_ACTIONS.includes(a)
            ) &&
            Array.isArray(buildActionMenuData()) &&
            buildActionMenuData().some((g) => (g.items || []).some((it) => it.action)) &&
            typeof dispatchMenuAction === 'function' &&
            typeof expandForMenu === 'function' &&
            typeof restoreFromMenu === 'function' &&
            MENU_EXTRA_H > 0,
          // 弹弓模式：弹射真窗——动作就位 + 复用真抛掷(startFlight) + 尺寸常量与模式位
          gameOk:
            MENU_ACTIONS.includes('game') &&
            typeof startFlight === 'function' &&
            typeof stopFlight === 'function' &&
            typeof slingshotMode === 'boolean' &&
            GAME_W > 0 &&
            GAME_H > 0,
          // 鱼身体积碰撞判定：鱼身边缘压到罐子就命中（点判定会漏的场景），远处不误判
          hitBodyOk: (() => {
            try {
              const t = { x: 500, y: 300, r: 23 }
              // 鱼中心在罐子正左方 (HW + r + PAD - 4)：鱼身右边缘已压进罐子 4px，
              // 旧的"点到圆心 < r+PAD"判定此时距离 46+23+8-4=73 > 31 会漏，新判定必须命中。
              const edgeX = t.x - (SG_FISH_HW + t.r + SG_HIT_PAD - 4)
              const edgeHit = fishBodyHitsTarget(edgeX, t.y, t)
              // 竖直方向同理：鱼身下边缘刚压到罐子上沿
              const edgeY = t.y - (SG_FISH_HH + t.r + SG_HIT_PAD - 4)
              const edgeHitY = fishBodyHitsTarget(t.x, edgeY, t)
              // 远处（中心距远超鱼身+罐子半径）必须不命中
              const farMiss = !fishBodyHitsTarget(t.x - 300, t.y, t)
              // 正中心必命中
              const centerHit = fishBodyHitsTarget(t.x, t.y, t)
              // 冷却常量就位，防止一次穿越横扫整塔
              return edgeHit && edgeHitY && farMiss && centerHit && SG_SHOT_HIT_CAP > 0 && SG_FISH_HW > 0
            } catch (e) {
              return false
            }
          })(),
          // 扫掠判定：高速跨过罐子（起止点都不碰、但路径穿过）必须命中，防力度加大后隧穿
          sweepOk: (() => {
            try {
              const t = { x: 500, y: 300, r: 23 }
              // 起点在罐子左侧很远、终点在右侧很远，两点都不碰，但水平线段正好穿过罐心
              const fromX = 500 - (SG_FISH_HW + 60), toX = 500 + (SG_FISH_HW + 60)
              const pointMiss = !fishBodyHitsTarget(fromX, 300, t) && !fishBodyHitsTarget(toX, 300, t)
              const sweepHit = fishSweepHitsTarget(toX, 300, fromX, 300, t)
              // 首帧无 prev 时退化为单点判定，仍应工作
              const noPrevOk = fishSweepHitsTarget(t.x, t.y, null, null, t)
              // 力度值在渲染层 probe.game.power 验证，这里只验证扫掠几何本身
              return pointMiss && sweepHit && noPrevOk
            } catch (e) {
              return false
            }
          })(),
          // 目标系统：窗口/生成/碰撞/渲染函数就位 + 第 1 关目标数据合理
          sgTargetOk: (() => {
            try {
              const area = { x: 0, y: 25, width: 1440, height: 875 }
              const launchX = Math.round(25 + Math.max(40, 1440 * 0.06))
              const launchY = Math.round(25 + 875 * 0.46 - 280 * 0.68)
              const sample = makeTargets({ x: launchX, y: launchY, w: 320, h: 280 }, area, 1)
              const hitFnOk = typeof checkTargetHits === 'function'
              const layerOk = typeof openTargetLayer === 'function' && typeof closeTargetLayer === 'function'
              const fishCx = launchX + 160
              const inBounds = sample.every((t) => t.x >= 25 && t.x <= 1440 - 25 && t.y >= 25 && t.y <= 900)
              const rightOfFish = sample.every((t) => t.x > fishCx + 100)
              const layoutOk = sample.length >= 5 && sample.every((t) => t.alive && t.pts > 0 && t.r > 0 && t.id > 0 && t.hp >= 1)
              return hitFnOk && layerOk && layoutOk && inBounds && rightOfFish
            } catch (e) {
              return false
            }
          })(),
          // 关卡系统：多套布局 + 造型互不相同 + 装甲罐 + 判定框不重叠 + 难度逐轮递增 + 移动靶
          sgLevelOk: (() => {
            try {
              const area = { x: 0, y: 25, width: 1440, height: 875 }
              const launch = { x: 111, y: 255, w: 320, h: 280 }
              const templatesOk = SG_LEVELS.length >= 5 && SG_LEVELS.every(
                (L) => L.name && L.r > 0 && L.rows.length > 0 &&
                  L.rows.some((row) => /[#@]/.test(row))
              )
              // 每关生成的图案签名不同（造型多样），且目标都在屏幕内
              const sigs = new Set()
              let armorSeen = false
              let allOk = true
              let gapOk = true
              for (let lv = 1; lv <= SG_LEVELS.length; lv++) {
                const ts = makeTargets(launch, area, lv)
                sigs.add(ts.map((t) => t.x + ',' + t.y).join('|'))
                if (ts.some((t) => t.hp > 1)) armorSeen = true
                if (!ts.length || ts.some((t) => t.x < 25 || t.x > 1415 || t.y < 25 || t.y > 900)) allOk = false
                // 同一排（相同 y）相邻目标间距 > 判定框直径，保证一发不能横扫一片
                const byRow = {}
                for (const t of ts) (byRow[t.y] = byRow[t.y] || []).push(t.x)
                for (const y in byRow) {
                  const xs = byRow[y].sort((a, b) => a - b)
                  for (let i = 1; i < xs.length; i++) {
                    if (xs[i] - xs[i - 1] < 2 * (ts[0].r + SG_HIT_PAD)) gapOk = false
                  }
                }
              }
              const varietyOk = sigs.size >= 5
              // 难度递增：同一模板第 2 轮半径更小、弹药更少，且出现移动靶
              const s1 = levelSpec(1)
              const s2 = levelSpec(1 + SG_LEVELS.length)
              const harderOk = s2.r < s1.r && s2.ammo < s1.ammo
              const movingOk = !s1.moving && s2.moving &&
                makeTargets(launch, area, 1 + SG_LEVELS.length).some((t) => t.swayAmp > 0)
              // 弹药按目标数精算（约 75%），不是拍脑袋的固定大数
              const ammoTight = levelSpec(1).ammo <= Math.ceil(levelSpec(1).count * 0.8)
              // 弹药流转 + 移动靶动画函数就位
              const flowOk = typeof onLevelClear === 'function' &&
                typeof onLevelFail === 'function' &&
                typeof nextLevel === 'function' &&
                typeof sendAmmo === 'function' &&
                typeof startSgAnim === 'function' && typeof stopSgAnim === 'function'
              return templatesOk && varietyOk && armorSeen && allOk && gapOk &&
                harderOk && movingOk && ammoTight && flowOk
            } catch (e) {
              return false
            }
          })(),
          // 弹弓物理：顶边上移一段(SG_CEIL_RAISE)给罐塔留空间，但反弹始终保留——
          // 高速上抛撞到顶边必须被弹回(vy 转正)，不再有 ceiling:false 让鱼飞出屏幕卡住。
          ceilPassOk: (() => {
            try {
              const raiseOk = SG_CEIL_RAISE > 0 && SG_CEIL_RAISE <= 200
              const bounds = { x: 0, y: 25, width: 1440, height: 875 }
              const walled = createFlight(200, 30, 0, -1600)
              step(walled, 1 / 60, bounds)
              const bounced = walled.vy > 0
              // 上抛若干帧后，即便越过了上移后的顶边也终会被弹回（vy 由负转正）
              const up = createFlight(200, 300, 0, -1800)
              const raised = { x: 0, y: bounds.y - SG_CEIL_RAISE, width: 1440, height: bounds.height + SG_CEIL_RAISE }
              let turned = false
              for (let i = 0; i < 90; i++) {
                step(up, 1 / 60, raised)
                if (up.vy > 0) { turned = true; break }
              }
              return raiseOk && bounced && turned
            } catch (e) {
              return false
            }
          })(),
          // 输入屏障：鼠标穿透恢复函数就位（退出弹弓时鱼窗口要能重新接收点击）
          barrierOk:
            typeof applyClickThrough === 'function' &&
            typeof closeTargetLayer === 'function' &&
            typeof slingshotMode === 'boolean',
        })
      })
      .catch((e) => finish({ menuBuilt: false, menuError: String((e && e.message) || e).slice(0, 400) }))
  })
  ipcMain.on('pet:debug', (_e, data) => {
    if (!process.argv.includes('--inputlog')) return
    try {
      require('node:fs').appendFileSync('/tmp/pet-input.log', JSON.stringify({ t: Date.now(), ...data }) + '\n')
    } catch {}
  })
  ipcMain.on('pet:drag-end', () => persistPosition())
  // 点一下鱼身：播随机点击音效。渲染层已经判过「没拖动」了，这里只管出声
  ipcMain.on('pet:click', () => {
    sfx.click(cfg)
    // 巡游中戳它 → 触发一次俏皮反应（害羞/打招呼），不只是普通点击音效。
    // 复用行为状态机的 react()，必定能推动画和台词；冷却由 reactUntil 管。
    if (crawlerOn && crawler && win && !win.isDestroyed()) {
      const kind = Math.random() < 0.5 ? 'shy' : 'greet'
      crawl.react(crawler, kind, Date.now())
      win.webContents.send('pet:crawl', { active: true, activity: crawler.activity, dir: crawler.dir })
    }
  })
  // 戳它 / 喂它都涨亲密度。渲染层戳的时候顺手报一下
  ipcMain.on('pet:bond', (_e, kind) => bumpBond(kind === 'feed' ? 'feed' : 'poke'))
  ipcMain.on('pet:menu', () => {
    if (!win) return
    Promise.resolve()
      .then(() => showMenu())
      .catch((e) => console.error('[pet] 右键菜单构建失败：', e))
  })
  // 自绘气泡菜单：渲染层右键时先报 open（主进程扩窗），收起时报 close（还原窗口）
  ipcMain.on('pet:menu-open', () => {
    if (crawlerOn) stopCrawl() // 巡游中打开菜单：先停下，免得扩窗和巡游的 setPosition 打架
    expandForMenu()
  })
  ipcMain.on('pet:menu-close', () => {
    restoreFromMenu()
  })
  // 弹弓模式：发射复用 pet:throw → startFlight，无需扩窗/还原。
  // 这两个是渲染层可选的同步入口——game-open 停巡游，game-close 停飞行，仅此而已。
  ipcMain.on('pet:game-open', () => {
    stopCrawlIfOn()
  })
  ipcMain.on('pet:game-close', () => {
    slingshotMode = false
    closeTargetLayer()
  })
  // 气泡菜单「更多」子页数据（同步生成，invoke 返回给渲染层渲染）
  ipcMain.handle('pet:menu-data', () => buildActionMenuData())
  // 气泡菜单项点击：主进程统一分发，执行后收起菜单还原窗口
  ipcMain.on('pet:action', (_e, action) => {
    dispatchMenuAction(action)
    if (action !== 'quit') restoreFromMenu()
  })
  // 聊天窗口：请求初始化信息（快捷话题 / 模式提示）
  ipcMain.on('chat:ready', () => {
    if (!chatWin || chatWin.isDestroyed()) return
    chatWin.webContents.send('chat:init', {
      quickAsks: chat.quickAsks(cfg),
      hint: chatHint(),
    })
  })
  // 玩家发话 → chat.reply 拿回答 → 桌宠表演 + 回显给聊天窗
  ipcMain.on('chat:send', async (_e, text) => {
    let r
    try {
      r = await chat.reply(chatConfig(), text, chatContext())
    } catch (e) {
      if (chatWin && !chatWin.isDestroyed())
        chatWin.webContents.send('chat:error', { error: String((e && e.message) || e).slice(0, 120) })
      return
    }
    // 桌宠：播动画 + 气泡 + 语音
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:chat', { line: r.line, anim: r.anim, online: r.online })
    }
    if (r.line) sfx.speakText(cfg, r.line)
    // 聊天窗：显示这条回复
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:reply', r)
  })
  ipcMain.on('chat:close', () => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.close()
  })
  ipcMain.on('chat:clear', () => {
    /* 对话记录只在渲染层内存里，清空由渲染层自己做，这里留通道备扩展 */
  })
  ipcMain.on('pet:quit', () => app.quit())

  tray = createTray({
    chat: () => openChatWindow(),
    poke: () => win && win.webContents.send('pet:poke'),
    speak: () => win && speakNow(),
    crawlLabel,
    toggleCrawl,
    reset: () => win && resetPosition(),
    openWorkBuddy: () => execFile('open', ['-a', 'WorkBuddy'], () => {}),
    openCursor: () => execFile('open', ['-a', 'Cursor'], () => {}),
    // 穿透开着的时候右键菜单唤不出来，托盘是唯一的后悔药
    clickThroughLabel,
    toggleClickThrough,
  })

  watcher = createWatcher(cfg)
  // 心情要看三家各自的状态，全量探测不必每秒做一次，隔一阵子扫一遍就够
  let moodAt = 0
  const tick = async () => {
    try {
      const s = await watcher.poll()
      if (s && win) pushState(s)
    } catch (e) {
      console.error('[pet] watcher error', e.message)
    }
    const now = Date.now()
    const every = (cfg.mood && cfg.mood.pollEveryMs) || 15000
    if (now - moodAt > every) {
      moodAt = now
      Promise.resolve()
        .then(() => watcher.pollAll())
        .then((all) => {
          applyMood(all)
          applyRoutine(all, now)
          applyOccasion(now)
          applyLonely(all, now)
          applyNote(all, now)
        })
        .catch(() => {})
    }
    // 下班小结：到点了念一句，一天一次
    if (digest.shouldFire(cfg, now)) {
      digest.markFired(cfg, now)
      sayDigest()
    }
  }
  tick()
  setInterval(tick, cfg.pollIntervalMs)
  watcher.watch((s) => pushState(s))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
