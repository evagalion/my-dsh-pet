'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

const { newestProject, cleanProjectName, readHead, decidePhase } = require('./transcript')

const DB = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db')
const PROJECTS = path.join(os.homedir(), '.cursor', 'projects')

// 判定逻辑（关键：不能只看"多久没写文件"，那样跑完了还会挂很久的"整理中"）
//   1. 20s 内还在写             -> working
//   2. 停了，且最后一句是 assistant -> success（这轮回答完了，庆祝一下）
//   3. 停了但最后一句不是 assistant -> organizing（还在收尾/等工具），最多再 30s
//   4. 超出冷却                  -> idle
const WORKING_MS = 20_000    // 20s 内有动静 -> 正在写
const DONE_MS = 35_000       // 停了且已回答完 -> 搞定的庆祝窗口
const COOLDOWN_MS = 50_000   // 除此之外最多再算 30s 收尾
const CACHE_MS = 400         // 去抖，别让轮询放大成密集查询

const QUERY =
  'SELECT' +
  ' (SELECT MAX(createdAt) FROM ai_code_hashes) AS lastEdit,' +
  ' (SELECT fileName FROM ai_code_hashes ORDER BY createdAt DESC LIMIT 1) AS lastFile,' +
  ' (SELECT title FROM conversation_summaries ORDER BY updatedAt DESC LIMIT 1) AS lastTitle'

function query(sql) {
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-json', `file:${DB}?mode=ro`, sql],
      { timeout: 4000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null)
        try {
          const rows = JSON.parse(stdout)
          return resolve(Array.isArray(rows) && rows.length ? rows[0] : null)
        } catch {
          return resolve(null)
        }
      }
    )
  })
}

// 会话记录比 ai_code_hashes 更准：它在 agent 一开口就开始写，而且能拿到"在处理哪个问题"
function bestTranscript() {
  const s = newestProject(PROJECTS, { depth: 2, dirName: 'agent-transcripts' })
  if (!s) return null
  const h = readHead(s.file, s.mtime, s.size)
  return {
    mtime: s.mtime,
    project: cleanProjectName(s.project),
    title: h.title,
    cwd: h.cwd,
    tail: h,
  }
}

function createCursorWatcher() {
  let cache = null
  let cacheAt = 0

  async function poll() {
    if (!fs.existsSync(DB) && !fs.existsSync(PROJECTS)) {
      return { source: 'cursor', online: false, phase: 'idle', project: '', detail: '', title: '' }
    }

    const now = Date.now()
    if (cache && now - cacheAt < CACHE_MS) return cache

    cacheAt = now
    const row = (await query(QUERY)) || null
    const age = row && row.lastEdit ? now - Number(row.lastEdit) : Infinity

    let project = ''
    if (row && row.lastFile) {
      const m = String(row.lastFile).match(/\/([^/]+)\/src\//)
      if (m) project = m[1]
      else {
        const parts = String(row.lastFile).split('/')
        project = parts[Math.max(0, parts.length - 2)] || ''
      }
    }

    const t = bestTranscript()
    // 两个信号取更"热"的那个：会话正在写 -> working，否则看最后一次落盘时间
    const tGap = t ? now - t.mtime : Infinity
    const hot = Math.min(age, tGap)

    const phase = decidePhase(hot, t ? t.tail : null, {
      working: WORKING_MS,
      done: DONE_MS,
      cooldown: COOLDOWN_MS,
    })

    cache = {
      source: 'cursor',
      online: hot < COOLDOWN_MS * 4,
      phase,
      project: (t && t.project) || cleanProjectName(project) || '',
      cwd: (t && t.cwd) || '',
      detail: row && row.lastFile ? path.basename(String(row.lastFile)) : '',
      title: (t && t.title) || (row && row.lastTitle) || '',
    }
    return cache
  }

  return { poll }
}

module.exports = { createCursorWatcher, DB, PROJECTS }
