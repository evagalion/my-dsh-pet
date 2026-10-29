'use strict'

const { app, BrowserWindow, screen, ipcMain, Menu, protocol, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const { loadConfig, saveConfig, listAssets } = require('./config')
const { ASSETS_DIR, ROOT } = require('./paths')
const { createWatcher } = require('./watcher')
const { createTray } = require('./tray')
const { createFlight, step } = require('../shared/physics')
const { classify, menuGroups } = require('../shared/animations')
const sfx = require('./sfx')
const feed = require('./feed')
const mood = require('./mood')
const calendar = require('./calendar')
const routine = require('./routine')
const coins = require('./coins')
const digest = require('./digest')
const achieve = require('./achieve')

const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

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
let cfg = null
let pools = null
let watcher = null
let flight = null
let flightTimer = null
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
  const b = win.getBounds()
  flight = createFlight(b.x, b.y, vx, vy)
  const bounds = boundsOf()
  stopFlightTimerOnly()
  let prev = Date.now()
  flightTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopFlightTimerOnly()
      return
    }
    const now = Date.now()
    const dt = Math.min(0.032, Math.max(0.001, (now - prev) / 1000))
    prev = now
    try {
      step(flight, dt, bounds)
      win.setPosition(Math.round(flight.x), Math.round(flight.y))
    } catch (e) {
      stopFlightTimerOnly()
      return
    }
    if (!flight.flying) {
      stopFlightTimerOnly()
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

// 喂鱼相关菜单项。饱腹度关掉时返回空数组（展开运算符会把它吃掉）
function feedMenuItems() {
  const v = feed.fullness(cfg)
  if (v == null) return []
  const pct = Math.round(v)
  const food = feed.pickFood(cfg)
  const occasion = feed.occasionOf(cfg)
  const label = occasion
    ? `喂点东西（今天${occasion}，想吃${food.replace(/^吃/, '')}）`
    : `喂点东西（现在想吃${food.replace(/^吃/, '')}）`
  return [
    {
      label,
      click: () => {
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
      },
    },
    { label: `饱腹度：${pct}%`, enabled: false },
  ]
}

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

  return Menu.buildFromTemplate([
    {
      label: `现在：${labelOf(lastKnown.phase)} · ${agentOf(lastKnown.source).label}${
        whatOf(lastKnown) ? ' · ' + whatOf(lastKnown) : ''
      }`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '摸一下', click: () => win.webContents.send('pet:poke') },
    ...feedMenuItems(),
    ...coinsMenuItems(),
    ...digestMenuItems(),
    ...achieveMenuItems(),
    ...moodMenuItems(),
    actionMenu(),
    { label: '它在干嘛？', click: () => speakNow() },
    { label: '各 agent 状态（点开看各自在忙啥）', submenu: statusItems },
    stepMenu(),
    { type: 'separator' },
    {
      label: '打开 WorkBuddy',
      click: () => execFile('open', ['-a', 'WorkBuddy'], () => {}),
    },
    { label: '打开 Cursor', click: () => execFile('open', ['-a', 'Cursor'], () => {}) },
    {
      label: '用 Cursor 打开当前项目',
      enabled: !!currentCwd(),
      click: () => execFile('open', ['-a', 'Cursor', currentCwd()], () => {}),
    },
    {
      label: '在终端打开当前项目',
      enabled: !!currentCwd(),
      click: () => execFile('open', ['-a', 'Terminal', currentCwd()], () => {}),
    },
    {
      label: '在访达中显示当前项目',
      enabled: !!currentCwd(),
      click: () => currentCwd() && shell.showItemInFolder(currentCwd()),
    },
    { type: 'separator' },
    { label: '回到屏幕右下角', click: () => resetPosition() },
    {
      label: soundMenuLabel(),
      click: () => {
        // 三态循环：语音 → 音效 → 关
        const cur = sfx.modeOf(cfg)
        const next = cur === 'voice' ? 'tone' : cur === 'tone' ? 'off' : 'voice'
        cfg.sound.enabled = next !== 'off'
        if (next !== 'off') cfg.sound.mode = next
        saveConfig(cfg)
        sfx.preview(cfg) // 切完立刻来一句，好确认音色/音量
      },
    },
    ...(sfx.auditionPath()
      ? [
          {
            label: '挑语音音色…（试听并复制配置）',
            click: () => shell.openPath(sfx.auditionPath()),
          },
        ]
      : []),
    ...(sfx.clickAvailable()
      ? [
          {
            label: clickMenuLabel(),
            click: () => {
              cfg.sound.click = cfg.sound.click || {}
              cfg.sound.click.enabled = cfg.sound.click.enabled === false
              saveConfig(cfg)
              if (cfg.sound.click.enabled !== false) sfx.click(cfg, true) // force：跳过节流，切完立刻听效果
            },
          },
        ]
      : []),
    {
      label: clickThroughLabel(),
      click: () => toggleClickThrough(),
    },
    {
      label: '重载配置',
      click: () => {
        const assets = listAssets()
        pools = classify(assets, cfg)
        sfx.resetEdgeProbe() // python 路径可能刚装好，重新探测一次
        win.webContents.send('pet:reload-config', { config: cfg, pools })
        lastMoodJson = '' // 配置可能改了亲密度等级，强制重推一次
        pushMood()
      },
    },
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

let lastCwd = ''
function currentCwd() {
  return lastCwd
}

function labelOf(phase) {
  const m = { idle: '摸鱼中', thinking: '思考', working: '工作中', organizing: '整理', waiting: '等你', success: '搞定', error: '出错' }
  return m[phase] || phase
}

function speakNow() {
  if (!watcher) return
  watcher.poll().then((s) => {
    if (s) pushState(s, true)
    else
      win.webContents.send(
        'pet:speak',
        Object.assign({}, lastKnown, { force: true })
      )
  })
}

function resetPosition() {
  const wa = screen.getDisplayMatching(win.getBounds()).workArea
  win.setPosition(wa.x + wa.width - win.getBounds().width - 48, wa.y + wa.height - win.getBounds().height - 12)
  persistPosition()
}

// 亲密度：戳一下 / 喂一口都涨一点，并把「上次互动时间」刷新（衰减从头算）
function bumpBond(kind) {
  mood.bumpBond(cfg, kind)
  pushMood()
  checkAchievements() // 亲密度可能刚好到 100
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

// 作息动画：早上刷牙 / 深夜打瞌睡 / 久坐伸懒腰
function applyRoutine(all, now) {
  if (!win || win.isDestroyed()) return
  const r = routine.watch(cfg, all, now)
  if (r) win.webContents.send('pet:routine', r)
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
        const walk = (items) => {
          for (const it of items || []) {
            if (it.label != null && typeof it.label !== 'string') bad.push(String(it.label))
            walk(it.submenu && it.submenu.items)
          }
        }
        walk(tpl.items)
        finish({ menuBuilt: true, menuItems: tpl.items.length, menuBadLabels: bad })
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
  ipcMain.on('pet:click', () => sfx.click(cfg))
  // 戳它 / 喂它都涨亲密度。渲染层戳的时候顺手报一下
  ipcMain.on('pet:bond', (_e, kind) => bumpBond(kind === 'feed' ? 'feed' : 'poke'))
  ipcMain.on('pet:menu', () => {
    if (!win) return
    Promise.resolve()
      .then(() => showMenu())
      .catch((e) => console.error('[pet] 右键菜单构建失败：', e))
  })
  ipcMain.on('pet:quit', () => app.quit())

  tray = createTray({
    poke: () => win && win.webContents.send('pet:poke'),
    speak: () => win && speakNow(),
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
