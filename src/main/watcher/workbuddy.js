'use strict'

// WorkBuddy 状态来源（实测可用，优先级从高到低）：
//   1. ~/.workbuddy/workbuddy.db  -> sessions 表：cwd / title / status / updated_at
//      updated_at 是秒级更新的活性字段，status 从 working 变 completed 就是"一轮跑完"。
//   2. ~/.workbuddy/changes-index/<sessionId>.json 的 mtime -> 正在改文件
//   注：sessions/*.json 里的 lastHeartbeat 只在会话启动时写一次，不能当心跳用（已踩坑）。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { stepsOf, stepText, workbuddyFile } = require('./steps')

const HOME = os.homedir()
const DB = path.join(HOME, '.workbuddy', 'workbuddy.db')
const CHANGES_DIR = path.join(HOME, '.workbuddy', 'changes-index')

// 判定以 sessions.status 为准（它直接写着 working / completed / error），
// 时间只用来区分"在改文件"还是"在想"。
// 踩坑：只靠"多久没更新"会把长任务误判成"等你确认"——跑一个长命令时
// last_activity_at 几十秒不动是常态，但 status 一直是 working。
const SESSION_TTL = 10 * 60_000 // 会话 10 分钟没动静就算过去了
const EDIT_MS = 20_000          // 20s 内有文件变更 -> 正在改文件
const QUIET_MS = 150_000        // status=working 但静默超过 2.5min -> 大概率真卡在等你确认
                                // （留够余量：跑一条长 bash 静默一两分钟很常见，别误报）
const WARM_MS = 45_000          // status 不明时的等待窗口
const OK_AFTER = 15_000         // 完成/出错的庆祝窗口
const STEP_LIMIT = 12           // 最多回溯多少步

const BUSY = /working|running|in[_-]?progress|active|pending|busy|streaming|tool/i
const DONE = /complet|done|success|finish/i
const BAD = /error|fail|abort|cancel|reject/i

const QUERY =
  'SELECT id, cwd, title, status, updated_at, last_activity_at' +
  ' FROM sessions' +
  ' ORDER BY updated_at DESC LIMIT 8'

function query() {
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-json', `file:${DB}?mode=ro`, QUERY],
      { timeout: 4000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null)
        try {
          const rows = JSON.parse(stdout)
          return resolve(Array.isArray(rows) ? rows : null)
        } catch {
          return resolve(null)
        }
      }
    )
  })
}

function lastChangeAt(sessionId) {
  try {
    return fs.statSync(path.join(CHANGES_DIR, sessionId + '.json')).mtimeMs || 0
  } catch {
    return 0
  }
}

function createWorkBuddyWatcher() {
  let prevStatus = new Map()
  let celebrated = new Set()
  let successAt = 0
  let errorAt = 0

  async function poll() {
    const off = { source: 'workbuddy', online: false, phase: 'idle', project: '', detail: '', title: '', cwd: '' }
    if (!fs.existsSync(DB)) return off

    const rows = await query()
    if (!rows || !rows.length) return off

    const now = Date.now()
    // 活性取 updated_at / last_activity_at 里更近的那个
    const actAt = (r) => Math.max(r.updated_at || 0, r.last_activity_at || 0)
    const cur = rows.find((r) => now - actAt(r) < SESSION_TTL)
    if (!cur) return off

    const st = String(cur.status || '')

    // 会话从"进行中"翻到"已完成" -> 一轮跑完了
    const prev = prevStatus.get(cur.id)
    if (prev && prev !== st) {
      if (DONE.test(st)) successAt = now
      else if (BAD.test(st)) errorAt = now
    }
    prevStatus.set(cur.id, st)

    // 状态本来就是完成态（比如桌宠中途才启动），也补一次庆祝，但只庆祝一次
    if (DONE.test(st) && !celebrated.has(cur.id)) {
      celebrated.add(cur.id)
      if (now - successAt > OK_AFTER) successAt = now
    }

    const gap = now - actAt(cur)
    const editGap = now - lastChangeAt(cur.id)

    let phase = 'idle'
    if (BAD.test(st)) phase = 'error'
    else if (now - errorAt < OK_AFTER) phase = 'error'
    else if (now - successAt < OK_AFTER) phase = 'success'
    else if (BUSY.test(st)) {
      // status 说在跑，那就还在跑：改着文件 -> working，没改 -> 在想
      if (editGap < EDIT_MS) phase = 'working'
      else if (gap < QUIET_MS) phase = 'thinking'
      else phase = 'waiting' // 跑着跑着静默太久，多半是真在等你点确认
    } else if (DONE.test(st)) phase = 'idle' // 庆祝过了就回摸鱼，别再挂着"等你"
    else if (gap < WARM_MS) phase = editGap < EDIT_MS ? 'working' : 'waiting'

    // 每一步在干嘛：会话记录里的 function_call（跟 cursor/codebuddy 同源的思路）
    const file = workbuddyFile(cur.id, cur.cwd)
    const steps = file ? stepsOf('workbuddy', file, { cwd: cur.cwd, limit: STEP_LIMIT }) : []
    // 只有在跑的时候才展示步骤，闲着的时候挂着上一步很怪
    const showStep = phase === 'working' || phase === 'thinking' || phase === 'organizing'

    return {
      source: 'workbuddy',
      online: true,
      phase,
      project: cur.cwd ? path.basename(cur.cwd) : '',
      cwd: cur.cwd || '',
      title: cur.title || '',
      detail: '',
      step: showStep && steps.length ? stepText(steps[0]) : '',
      steps,
      successAt,
      errorAt,
    }
  }

  return { poll }
}

module.exports = { createWorkBuddyWatcher, DB, CHANGES_DIR }
