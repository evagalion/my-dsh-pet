'use strict'

// Cursor 和 CodeBuddy 的会话记录是同一种东西：~/.xx/projects/<项目>/<会话>.jsonl，
// 边跑边往里追加。这里放两个共用工具：找最新那份 + 抠出第一条用户消息（= 正在处理的问题）。

const fs = require('node:fs')
const path = require('node:path')

// 在一个目录里找最新的 .jsonl。
// depth 控制往下钻几层，dirName 用来只进某个子目录（Cursor 的会话都在 agent-transcripts 下）。
function bestJsonl(dir, opts) {
  opts = opts || {}
  const depth = opts.depth == null ? 1 : opts.depth
  const dirName = opts.dirName || null

  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }

  let best = null
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue
        if (dirName && e.name !== dirName) continue
        if (depth <= 0) continue
        const r = bestJsonl(p, { depth: depth - 1 })
        if (r && (!best || r.mtime > best.mtime)) best = r
      } else if (e.name.endsWith('.jsonl')) {
        const st = fs.statSync(p)
        if (!best || st.mtimeMs > best.mtime) best = { file: p, mtime: st.mtimeMs, size: st.size }
      }
    } catch {
      /* ignore */
    }
  }
  return best
}

// 扫 ~/.xx/projects 下所有项目，返回最新的那一份会话
function newestProject(root, opts) {
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  let best = null
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const r = bestJsonl(path.join(root, d.name), opts)
    if (r && (!best || r.mtime > best.mtime)) best = Object.assign({ project: d.name }, r)
  }
  return best
}

// 目录名形如 Users-danghaoyu-go_workspace-xxx -> 剥掉机器前缀，只留项目名
function cleanProjectName(name) {
  return String(name || '')
    .replace(/^Users-[^-]+-/, '')
    .replace(/^(go_)?workspace-/, '')
}

// 剥掉 <timestamp>…</timestamp>、<system-reminder>…</system-reminder> 这类整块标签，
// 再压平空白，剩下的才是人话
function cleanText(raw) {
  let t = String(raw || '')
  t = t.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, ' ')
  t = t.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, ' ')
  t = t.replace(/<[^>]+>/g, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

// 读文件尾，判断这轮到底跑完没有：
//   role      最后一条消息是谁说的（assistant = 轮到它说完话了）
//   wantsTool assistant 这句里带不带 tool_use —— 带的话它只是在发起工具调用，还在跑
// 只读 16KB，最后一行可能是写了一半的，要跳过。
function readTail(file, size) {
  const out = { role: '', wantsTool: false, turnEnded: false, status: '', aiTitle: '' }
  try {
    const len = Math.min(16384, size)
    if (len <= 0) return out
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, Math.max(0, size - len))
    fs.closeSync(fd)

    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      // 顺路把 AI 生成的会话标题（CodeBuddy 的 ai-title）也捞出来，它比首条用户消息更像"问题"
      if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) {
        out.aiTitle = o.aiTitle.slice(0, 48)
      }
      if (i === lines.length - 1 && size > len) continue // 尾巴上截断的半行
      if (!o || (!o.role && !o.type)) continue
      const ty = String(o.type || '')
      out.role = String(o.role || o.type)
      // 两个工具都会在一轮结束时打标记：Cursor 写 {"type":"turn_ended","status":"success"}，
      // CodeBuddy 写 turn-metrics。看到它 = 这轮真的跑完了，不用再靠"多久没写文件"猜。
      out.turnEnded = /turn_ended|turn-metrics/i.test(ty)
      out.status = String(o.status || o.result || '')
      const c = (o.message && o.message.content) || o.content
      if (Array.isArray(c)) {
        for (const p of c) {
          if (p && /tool/i.test(String(p.type || ''))) {
            out.wantsTool = true
            break
          }
        }
      }
      break
    }
  } catch {
    /* ignore */
  }
  return out
}

const headCache = new Map()
const HEAD_BYTES = 24576

// 读文件头（前 24KB / 24 行）+ 文件尾，一次拿到三样东西：
//   title    —— 第一条真正的用户消息 = 正在处理哪个问题
//   cwd      —— 这个项目在哪个目录（右键"在终端打开"要用）
//   lastRole  —— 最后一条消息是谁说的（assistant 且不带 tool_use = 这轮回答完了）
//   wantsTool —— assistant 这句是在发起工具调用（还在跑，别急着庆祝）
// 按文件版本缓存，别让轮询变重。
function readHead(file, mtime, size) {
  const key = file + '@' + mtime
  if (headCache.has(key)) return headCache.get(key)

  const out = { title: '', cwd: '' }
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)

    for (const line of buf.toString('utf8').split('\n').slice(0, 24)) {
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!o) continue

      if (!out.cwd && typeof o.cwd === 'string' && o.cwd) out.cwd = o.cwd
      if (!out.aiTitle && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) {
        out.aiTitle = o.aiTitle.slice(0, 48)
      }

      if (out.title) continue
      // Cursor 走 role:"user"，CodeBuddy 走 type:"message" + role:"user"，两种都认
      if (o.type !== 'user' && o.role !== 'user') continue

      // Cursor 的内容在 message.content，CodeBuddy 直接在 content
      const c = (o.message && o.message.content) || o.content
      let raw = typeof c === 'string' ? c : ''
      if (Array.isArray(c)) {
        const p = c.find((x) => x && (x.type === 'text' || x.type === 'input_text'))
        raw = (p && p.text) || ''
      }
      const t = cleanText(raw)
      // 跳过 system-reminder / Caveat 这类自动注入的东西，
      // 也跳过纯斜杠命令（"/mcp" 这种看不出在处理啥）
      const junk = /^caveat:/i.test(t) || /^do not respond/i.test(t) || /^\/[a-z][\w-]*\s*$/i.test(t)
      if (t && !junk) out.title = t.slice(0, 48)
    }
  } catch {
    /* ignore */
  }

  const tail = readTail(file, size || 0)
  out.lastRole = tail.role
  out.wantsTool = tail.wantsTool
  out.turnEnded = tail.turnEnded
  out.status = tail.status
  if (!out.aiTitle && tail.aiTitle) out.aiTitle = tail.aiTitle
  // 标题优先用 AI 生成的，比首条用户消息（可能是 "/mcp" 这种）更像是"在处理哪个问题"
  out.title = out.aiTitle || out.title

  if (headCache.size > 80) headCache.clear()
  headCache.set(key, out)
  return out
}

// 统一的档位判定：先认"轮次结束"标记，再退化到时间阈值
//   turnEnded -> 成功/失败（庆祝或叹气一小会儿），超时就彻底空闲，绝不退回"整理中"
//   还在写   -> working
//   停了且最后是 assistant 且没在调工具 -> 算跑完
//   其余     -> 最多再算一小段"收尾"，然后空闲
function decidePhase(gap, tail, t) {
  const W = t.working
  const D = t.done
  const C = t.cooldown
  const bad = /abort|cancel|error|fail/i.test((tail && tail.status) || '')

  if (tail && tail.turnEnded) return gap < D ? (bad ? 'error' : 'success') : 'idle'
  if (gap < W) return 'working'
  if (tail && tail.role === 'assistant' && !tail.wantsTool) return gap < D ? 'success' : 'idle'
  if (gap < C) return 'organizing'
  return 'idle'
}

module.exports = { bestJsonl, newestProject, cleanProjectName, readHead, decidePhase }
