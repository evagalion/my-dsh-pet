'use strict'

// 听歌一起蹦 —— 检测「正在听什么歌」，状态变了就让桌宠跟着蹦一句。
//
// 播放来源（按优先级）：
//   1. 网易云音乐（国内最常用）：零授权读它自己的本地播放记录 sqlite。
//      网易云不提供 AppleScript 接口、不注册系统 Now Playing、本地 HTTP 端口也不吐状态，
//      但它把「最近播放的歌」实时写进本地 sqlite：
//        ~/Library/Application Support/com.netease.163music/Documents/storage/sqlite_storage.sqlite3
//      关键：盯的是 historyTracks 表（"最近播放"流水）——每切一首歌就新增一行，
//        rowid=插入顺序、jsonStr.name=歌名、jsonStr.playtime=切歌时刻。
//      实测铁证：切歌瞬间 historyTracks 立刻多一行；而 playingCount 要等这首歌
//        播了约 2 分钟才补一条统计，读它会报成上一首歌（用户实际踩到的坑）。
//      （踩过的坑：曾误盯 playingCount 并用 dbTrack 反查歌名，结果切歌报上一首。
//       historyTracks 才是「当前正在播哪首」的实时源。）
//      检测到更大的 rowid 且歌名不同 = 切了新歌 → 报 {type:'track', track, app:'网易云'}。
//      只读文件、不写入、immutable 打开避免锁冲突。
//   2. Apple Music / Spotify：AppleScript 只读查播放状态（不注入事件、不读别的窗口）。
//      没授权自动化时自动降级（当作没在听），不影响网易云那条路。
//
// 所有解析/比对都是纯函数，自检直接喂样本，不真读文件、不惊动系统。

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// AppleScript：同时问 Music / Spotify，谁在播用谁。输出 "APP|STATE|TRACK;"
const QUERY = `
set out to ""
repeat with p in {"Music", "Spotify"}
  try
    tell application p
      if it is running then
        set st to "paused"
        try
          if player state is playing then set st to "playing"
        end try
        set nm to ""
        try
          set nm to name of current track
        end try
        set out to out & (p as text) & "|" & st & "|" & nm & ";"
      end if
    end tell
  end try
end repeat
return out
`

// 网易云 sqlite 路径（Mac 桌面端 3.x）
function neteaseDb() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'com.netease.163music', 'Documents', 'storage', 'sqlite_storage.sqlite3')
}

let lastState = 'stopped' // Apple 侧：playing | paused | stopped
let lastTrack = ''
let lastQueryAt = 0

// 网易云侧：见过的最新 historyTracks.rowid / 歌名。第一次读到只记不报，避免开机就蹦。
let ncSeeded = false
let ncRowid = 0
let ncTrack = ''
let ncAt = 0

function cfgOf(cfg) {
  return (cfg && cfg.music) || {}
}

// ---- 纯函数：AppleScript 输出解析 ----
function parseStatus(raw) {
  const parts = String(raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  let paused = null
  for (const p of parts) {
    const [app, state, ...rest] = p.split('|')
    if (!app || !state) continue
    const item = { app, state, track: rest.join('|').trim() }
    if (state === 'playing') return item
    if (state === 'paused' && !paused) paused = item
  }
  if (paused) return paused
  return { app: '', state: 'stopped', track: '' }
}

// 纯函数：Apple 侧前后状态比对 → start / pause / track / stop / null
function diff(prev, cur) {
  const ps = (prev && prev.state) || 'stopped'
  const cs = (cur && cur.state) || 'stopped'
  if (cs === 'playing' && ps !== 'playing') return 'start'
  if (cs !== 'playing' && ps === 'playing') return 'pause'
  if (cs === 'playing' && ps === 'playing' && cur.track !== prev.track) return 'track'
  if (cs === 'stopped' && ps !== 'stopped') return 'stop'
  return null
}

// 纯函数：网易云前后播放记录比对（historyTracks.rowid 自增）。
// prev/cur 形如 {rowid, track, time}。首次（prev=null）返回 null 只播种。
// 出现更大 rowid 且有歌名 → track 事件；同一首歌重复记不报（歌名相同）。
// 沿用 rowid 字段名（现在直接就是 historyTracks 的真实 rowid）。
function diffNetease(prev, cur) {
  if (!cur || !cur.rowid) return null
  if (!prev || !prev.rowid) return null // 首次：交给调用方播种
  if (cur.rowid <= prev.rowid) return null
  if (!cur.track || cur.track === prev.track) return null
  return { type: 'track', app: '网易云音乐', track: cur.track }
}

// ---- 网易云：只读读本地「最近播放」实时流水 ----
// historyTracks：每切一首歌就新增一行（rowid 自增、jsonStr.name=歌名、playtime=切歌时刻）。
//   实测：切歌瞬间这里立刻多一行；playingCount 却要等约 2 分钟才补统计（滞后一拍，
//   读它就会报成上一首歌）。所以「当前在播哪首」以 historyTracks 最新一行为准。
// 用系统 sqlite3 + immutable 只读打开（文件正被网易云占用，immutable 避免锁等待）。
// 返回 Promise<{rowid, track, time} | null>
function readNetease(cb) {
  const db = neteaseDb()
  let done = false
  const finish = (v) => { if (!done) { done = true; cb(v) } }
  try {
    if (!fs.existsSync(db)) return finish(null)
    // 直接取最近播放表最新一行：rowid（插入顺序）、jsonStr（含 name / playtime）。
    // 不依赖 JSON1，把 jsonStr 整段读回来在 JS 里 JSON.parse 即可。
    const sql = 'SELECT rowid, jsonStr FROM historyTracks ORDER BY rowid DESC LIMIT 1;'
    execFile(
      '/usr/bin/sqlite3',
      ['-separator', '\x1f', 'file:' + db + '?immutable=1', sql],
      { timeout: 1500 },
      (err, stdout) => {
        if (err || !stdout) return finish(null)
        try {
          const line = String(stdout).trim().split('\n')[0]
          const [rowidStr, json] = line.split('\x1f')
          const rowid = Number(rowidStr)
          if (!rowid) return finish(null)
          let track = ''
          let at = 0
          try {
            const d = JSON.parse(json || '{}')
            track = d.name || d.songName || d.trackName || ''
            at = Number(d.playtime) || 0
          } catch (e) {}
          // 没解析出歌名就跳过这一条（宁可漏报，也不报个错名字），等下一轮再读
          if (!track) return finish(null)
          finish({ rowid, track, time: at })
        } catch (e) {
          finish(null)
        }
      }
    )
  } catch (e) {
    finish(null)
  }
  setTimeout(() => finish(null), 2500)
}

// AppleScript 查询（回调）
function queryApple(cb) {
  let done = false
  const finish = (v) => { if (!done) { done = true; cb(v) } }
  try {
    execFile('osascript', ['-e', QUERY], { timeout: 1500 }, (err, stdout) => {
      finish(err ? { app: '', state: 'stopped', track: '' } : parseStatus(stdout))
    })
  } catch (e) {
    finish({ app: '', state: 'stopped', track: '' })
  }
  setTimeout(() => finish({ app: '', state: 'stopped', track: '' }), 2500)
}

// 轮询入口：节流 + 去抖，只在状态变化时返回事件。
// 网易云优先（国内用户主场景），读不到再退回 Apple 两家。
// 返回 Promise<{type, app, track} | null>
function poll(cfg, now) {
  return new Promise((resolve) => {
    const c = cfgOf(cfg)
    if (c.enabled === false) return resolve(null)
    const ts = Number(now) || Date.now()
    if (ts - lastQueryAt < (c.pollMs || 4000)) return resolve(null)
    lastQueryAt = ts

    // 先查网易云
    readNetease((nc) => {
      if (nc) {
        const prev = ncSeeded ? { rowid: ncRowid, track: ncTrack, time: ncAt } : null
        // 播种：第一次读到，只记下不报
        if (!ncSeeded) {
          ncSeeded = true; ncRowid = nc.rowid; ncTrack = nc.track; ncAt = nc.time
        } else {
          const ev = diffNetease(prev, nc)
          if (ev) {
            ncRowid = nc.rowid; ncTrack = nc.track; ncAt = nc.time
            return resolve(ev)
          }
          ncRowid = nc.rowid; ncTrack = nc.track; ncAt = nc.time
        }
      }
      // 网易云没给出事件，再查 Apple 两家
      queryApple((cur) => {
        const prev = { state: lastState, track: lastTrack }
        const type = diff(prev, cur)
        lastState = cur.state
        lastTrack = cur.track || ''
        if (!type) return resolve(null)
        resolve({ type, app: cur.app, track: cur.track })
      })
    })
  })
}

function snapshot(cfg) {
  return {
    enabled: cfgOf(cfg).enabled !== false,
    netease: { seeded: ncSeeded, rowid: ncRowid, track: ncTrack, db: neteaseDb() },
    apple: { state: lastState, track: lastTrack },
  }
}

module.exports = {
  poll, parseStatus, diff, diffNetease, snapshot, query: queryApple,
  readNetease, neteaseDb,
}
