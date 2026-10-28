'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { createWorkBuddyWatcher } = require('./workbuddy')
const { createCursorWatcher } = require('./cursor')
const { createCodeBuddyWatcher, PROJECTS: CB_PROJECTS } = require('./codebuddy')
const { PROJECTS: CURSOR_PROJECTS } = require('./cursor')

// 优先级：出错 > 等你 > 工作中 > 整理 > 思考 > 空闲
const RANK = { error: 6, waiting: 5, working: 4, organizing: 3, thinking: 2, success: 1, idle: 0 }
const TRANSIENT = new Set(['success', 'error'])

function pick(a, b) {
  if (!a) return b
  if (!b) return a
  const at = TRANSIENT.has(a.phase) && a.transient ? RANK[a.phase] + 10 : RANK[a.phase]
  const bt = TRANSIENT.has(b.phase) && b.transient ? RANK[b.phase] + 10 : RANK[b.phase]
  return bt > at ? b : a
}

function createWatcher(config) {
  const sources = []
  const add = (id, factory) => {
    if (config.sources[id] === false) return
    const w = factory()
    sources.push({ id, poll: () => w.poll() })
  }
  add('workbuddy', createWorkBuddyWatcher)
  add('cursor', createCursorWatcher)
  add('codebuddy', createCodeBuddyWatcher)

  let last = null
  let lastSentAt = 0
  let lastAll = []

  // 每个 agent 各自的一份状态，用于右键菜单里的「各 agent 状态」
  async function pollAll() {
    const now = Date.now()
    const results = await Promise.all(
      sources.map((s) =>
        Promise.resolve()
          .then(() => s.poll())
          .catch(() => null)
      )
    )
    lastAll = results.map((r, i) => {
      const base = r || { source: sources[i].id, phase: 'idle', online: false }
      const o = Object.assign(
        { source: sources[i].id, phase: 'idle', online: false, project: '', cwd: '', title: '', detail: '' },
        base
      )
      o.transient =
        TRANSIENT.has(o.phase) &&
        now - (o.phase === 'error' ? o.errorAt || 0 : o.successAt || 0) < config.transientMs
      return o
    })
    return lastAll
  }

  async function poll() {
    const now = Date.now()
    const results = await pollAll()

    let best = null
    for (const r of results) {
      if (!r || r.phase === 'idle') continue
      best = pick(best, r)
    }

    if (!best) {
      best = { source: 'none', phase: 'idle', project: '', detail: '', title: '', online: false, transient: false }
    } else if (best.transient === undefined) {
      best.transient = false
    }

    const snapshot = {
      phase: best.phase,
      source: best.source,
      project: best.project || '',
      cwd: best.cwd || '',
      title: best.title || '',
      detail: best.detail || '',
      online: !!best.online,
      at: now,
    }

    const changed =
      !last ||
      last.phase !== snapshot.phase ||
      last.project !== snapshot.project ||
      last.detail !== snapshot.detail ||
      last.source !== snapshot.source

    if (changed || now - lastSentAt > 10_000) {
      lastSentAt = now
      last = snapshot
      return snapshot
    }
    return null
  }

  // 轮询之外再挂一层文件系统事件：文件一改就立刻算一次，不用等下一个轮询周期。
  // macOS 的 fs.watch 不递归，CodeBuddy 得逐个项目目录挂。
  function watchTargets() {
    const home = os.homedir()
    const dirs = [
      path.join(home, '.workbuddy'), // workbuddy.db 一写就有事件（sessions.updated_at）
      path.join(home, '.workbuddy', 'changes-index'),
      path.join(home, '.cursor', 'ai-tracking'),
    ]

    // Cursor 会话在 <项目>/agent-transcripts/<会话> 两层下面，fs.watch 不递归，
    // 所以每个项目挂一层 agent-transcripts，再挑最近改过的几个会话目录挂上。
    try {
      for (const d of fs.readdirSync(CURSOR_PROJECTS, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue
        const at = path.join(CURSOR_PROJECTS, d.name, 'agent-transcripts')
        let subs
        try {
          subs = fs.readdirSync(at, { withFileTypes: true })
        } catch {
          continue
        }
        dirs.push(at)
        const recent = subs
          .filter((s) => s.isDirectory() && !s.name.startsWith('.'))
          .map((s) => {
            let m = 0
            try {
              m = fs.statSync(path.join(at, s.name)).mtimeMs
            } catch {
              /* ignore */
            }
            return { name: s.name, m }
          })
          .sort((a, b) => b.m - a.m)
          .slice(0, 8)
        for (const s of recent) dirs.push(path.join(at, s.name))
      }
    } catch {
      /* ignore */
    }

    // CodeBuddy 的 jsonl 就在项目目录第一层
    try {
      for (const d of fs.readdirSync(CB_PROJECTS, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.')) dirs.push(path.join(CB_PROJECTS, d.name))
      }
    } catch {
      /* ignore */
    }
    return dirs
  }

  function watch(onChange) {
    let pulse = null
    const pulseNow = () => {
      if (pulse) return
      pulse = setTimeout(async () => {
        pulse = null
        try {
          const s = await poll()
          if (s) onChange(s)
        } catch {
          /* ignore */
        }
      }, 250)
    }
    for (const dir of watchTargets()) {
      try {
        fs.watch(dir, { persistent: false }, pulseNow)
      } catch {
        /* ignore */
      }
    }
  }

  return { poll, pollAll, watch }
}

module.exports = { createWatcher }
