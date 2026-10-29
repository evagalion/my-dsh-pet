'use strict'

// 把 agent 每一步在干嘛从会话记录里抠出来。
//
// 三家格式不一样，但都能拿到"工具名 + 参数"：
//   WorkBuddy  ~/.workbuddy/projects/<slug>/<sessionId>.jsonl
//              {"type":"function_call","name":"Bash","arguments":"{...字符串...}"}
//   CodeBuddy  ~/.codebuddy/projects/<项目>/<会话>.jsonl
//              同上（同宗 CLI），arguments 也是字符串
//   Cursor     ~/.cursor/projects/<项目>/agent-transcripts/<会话>/<会话>.jsonl
//              {"role":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{...对象...}}]}}
//
// 统一成 { tool, verb, target, at }，verb 是中文动词，target 是"对谁动手"。

const fs = require('node:fs')
const path = require('node:path')

const TAIL_BYTES = 262144 // 256KB：Write/Edit 的参数能到几十 KB，读少了会漏掉最近的步骤
const MAX_KEEP = 40

// 工具名 -> 中文动词
const VERB = {
  read: '读',
  readfile: '读',
  view: '读',
  notebookread: '读',
  write: '写',
  create: '写',
  writefile: '写',
  notebookwrite: '写',
  edit: '改',
  strreplace: '改',
  multiedit: '改',
  replace: '改',
  stringreplace: '改',
  update: '改',
  delete: '删',
  remove: '删',
  glob: '找',
  ls: '列',
  list: '列',
  listdirectory: '列',
  grep: '搜',
  search: '搜',
  codesearch: '搜',
  find: '搜',
  semanticsearch: '搜',
  bash: '跑命令',
  shell: '跑命令',
  terminal: '跑命令',
  execute: '跑命令',
  run: '跑命令',
  repl: '跑脚本',
  websearch: '搜网页',
  webfetch: '看网页',
  browse: '看网页',
  fetch: '看网页',
  taskcreate: '建任务',
  taskupdate: '更新任务',
  taskget: '看任务',
  todowrite: '更新待办',
  task: '派子任务',
  agent: '派子任务',
  subagent: '派子任务',
  sendmessage: '找同事',
  askuserquestion: '问你',
  skill: '用技能',
  read_me: '查文档',
  toolsearch: '找工具',
  defer_execute_tool: '调工具',
  defer_execute_tool_: '调工具',
  defer: '调工具',
  enterplanmode: '做计划',
  exitplanmode: '交计划',
  present_files: '交付',
  show_widget: '画图',
  imagegen: '生成图',
  videogen: '生成视频',
  git: 'git',
}

function verbOf(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z_]/g, '')
  return VERB[n] || ''
}

// 参数可能是 JSON 字符串（WorkBuddy/CodeBuddy），也可能是对象（Cursor）
function parseArgs(a) {
  if (!a) return {}
  if (typeof a === 'object') return a
  if (typeof a === 'string') {
    try {
      const o = JSON.parse(a)
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  return {}
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function basename(p) {
  const s = String(p || '')
  if (!s) return ''
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

// 绝对路径 -> 相对当前项目的短路径，读起来更有信息量
function shortPath(p, cwd) {
  const s = String(p || '')
  if (!s) return ''
  if (cwd && s.startsWith(cwd)) return s.slice(cwd.length).replace(/^\//, '') || basename(s)
  // 太长的话只留最后两段
  const seg = s.split('/').filter(Boolean)
  return seg.length > 2 ? seg.slice(-2).join('/') : s
}

// 命令只取真正在干的那一段：
//   先去掉前导的 `cd xxx &&`（否则只剩一个 cd，看不出在干嘛），再切第一段，
//   最后把 node -e / python -c 这种内联脚本认出来（否则只剩一行噪音开头）。
function cleanCommand(cmd) {
  const raw = String(cmd || '').replace(/\\\n/g, ' ')
  let s = raw.replace(/^\s*\(?\s*cd\s+[^\s;&|)]+\s*(?:&&|;)\s*/i, '')
  const seg =
    s
      .split(/\n|&&|\|\||;/)
      .map((x) => String(x).trim())
      .find((x) => x && !/^cd\s/.test(x)) || ''
  s = seg || s.trim()
  if (!s) s = raw.split(/\n/)[0].trim()
  // 去掉 PYTHONDONTWRITEBYTECODE=1 这类环境变量前缀，露出真正的命令
  s = s.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '')
  return s
}

// 内联脚本（node -e / python -c）本身没什么可看的，试着从脚本里抠一个文件名出来
function scriptHint(cmd) {
  const s = String(cmd || '')
  // 只认像路径的东西（带目录分隔符 + 扩展名），require("os") 这种不算
  const m = s.match(/(?:~\/|\/|[A-Za-z0-9_.-]+\/)[\w.-]*\/[\w.-]+\.[a-z]{1,8}/)
  return m ? basename(m[0]) : ''
}

// node -e / python -c / <<PY 这种属于"跑一段脚本"，不是跑命令
function isInlineScript(c) {
  return /^(node|nodejs|deno|bun|python[23]?|ruby|perl)\s+(-e|-c)\b/i.test(c) || /<</.test(c)
}

function hostOf(url) {
  try {
    return new URL(String(url)).host.replace(/^www\./, '')
  } catch {
    return String(url || '')
  }
}

// 工具名 + 参数 -> 人话
function describe(name, args, cwd) {
  const n = String(name || '')
  const verb = verbOf(n) || n
  const a = args || {}

  const file = a.file_path || a.path || a.filePath || a.target_file || a.notebook_path
  const dir = a.target_directory || a.directory || a.dir
  const cmd = a.command || a.cmd || a.script
  const pattern = a.pattern || a.regex || a.query || a.search
  const glob = a.glob_pattern || a.glob
  const url = a.url || a.uri
  const title = a.title || a.subject || a.activeForm || a.name
  const q = a.question || a.description || a.prompt || a.content
  const lower = String(name || '').toLowerCase()

  // 命令类优先看 command，别被 path 抢走
  if (/bash|shell|terminal|execute|run|repl/i.test(lower) && cmd) {
    const c = cleanCommand(cmd)
    if (isInlineScript(c)) return { verb: '跑脚本', target: clip(scriptHint(cmd), 26) }
    return { verb, target: clip(c, 42) }
  }
  if (/websearch/i.test(lower)) {
    const t = pattern || q || a.arguments
    return { verb, target: clip(typeof t === 'string' ? t : JSON.stringify(t), 34) }
  }
  if (/webfetch|browse|fetch/i.test(lower) && url) {
    return { verb, target: hostOf(url) }
  }
  if (/glob|listdirectory|^ls$|^list$/i.test(lower)) {
    const t = glob ? clip(glob, 30) : shortPath(dir || a.path || '', cwd)
    return { verb: glob ? '找' : verb, target: t }
  }
  if (/grep|search|find|semanticsearch/i.test(lower) && pattern) {
    return { verb, target: clip(pattern, 34) }
  }
  if (/taskcreate|taskupdate|todowrite/i.test(lower)) {
    const t = title || a.taskId || ''
    return { verb, target: clip(t, 30) }
  }
  if (/askuserquestion/i.test(lower)) {
    let text = a.question || ''
    if (!text && Array.isArray(a.questions) && a.questions[0]) text = a.questions[0].question || ''
    if (!text && typeof q === 'string') text = q
    return { verb, target: clip(text, 34) }
  }
  if (/show_widget|present_files|imagegen|videogen/i.test(lower)) {
    return { verb, target: clip(title || a.filename || '', 30) }
  }
  if (/defer|toolsearch|call|call_dynamic_tool|calldynamictool/i.test(lower)) {
    const inner = a.toolName || a.name || a.tool || a.tool_name
    return { verb: '调工具', target: clip(inner || '', 30) }
  }
  if (/sendmessage|message/i.test(lower)) {
    return { verb, target: clip(a.to || a.recipient || (typeof q === 'string' ? q : ''), 30) }
  }
  if (/enterplanmode|exitplanmode/i.test(lower)) return { verb, target: '' }
  if (/^skill$/i.test(lower)) return { verb, target: clip(a.skill || a.name || '', 26) }
  if (/^read_me$/i.test(lower)) return { verb, target: clip(a.modules || '', 26) }
  if (/^task$|^agent$|^subagent$/i.test(lower)) {
    return { verb, target: clip(a.description || a.prompt || '', 30) }
  }
  if (file) {
    const isFileTool = /read|write|edit|replace|delete|remove|notebook|create/i.test(lower) || !dir
    if (isFileTool) return { verb, target: clip(shortPath(file, cwd), 34) }
  }
  // 兜底：把参数里第一眼能看的字符串拿出来
  const first = [file, dir, pattern, glob, cmd, url, title, q].find((v) => typeof v === 'string' && v.trim())
  return { verb, target: clip(first || '', 30) }
}

function readTailText(file, size) {
  try {
    const st = fs.statSync(file)
    const len = Math.min(TAIL_BYTES, st.size)
    if (len <= 0) return ''
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len))
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

// WorkBuddy / CodeBuddy：type === "function_call"
function fromFunctionCalls(lines, cwd, limit) {
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]
    if (!line || line.indexOf('"function_call"') < 0) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || o.type !== 'function_call' || !o.name) continue
    const d = describe(o.name, parseArgs(o.arguments), cwd)
    out.push({
      tool: String(o.name),
      verb: d.verb,
      target: d.target,
      at: Number(o.timestamp) || 0,
    })
  }
  return out // 新的在前
}

// Cursor：assistant 消息里的 tool_use 数组
function fromToolUse(lines, cwd, limit) {
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]
    if (!line || line.indexOf('"tool_use"') < 0) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const c = o && o.message && o.message.content
    if (!Array.isArray(c)) continue
    // 一条 assistant 消息里可能有好几个并行工具调用，倒着取
    for (let j = c.length - 1; j >= 0 && out.length < limit; j--) {
      const it = c[j]
      if (!it || it.type !== 'tool_use' || !it.name) continue
      const d = describe(it.name, it.input, cwd)
      out.push({
        tool: String(it.name),
        verb: d.verb,
        target: d.target,
        at: Number(o.timestamp) || 0,
      })
    }
  }
  return out
}

const cache = new Map()

// 对外：读某个会话文件的"最近几步"
//   返回 [{tool, verb, target, at}]，index 0 是最新一步
function stepsOf(source, file, opts) {
  opts = opts || {}
  const limit = Math.max(1, Math.min(MAX_KEEP, opts.limit || 10))
  const cwd = opts.cwd || ''
  if (!file) return []
  let mtime = 0
  let size = 0
  try {
    const st = fs.statSync(file)
    mtime = st.mtimeMs
    size = st.size
  } catch {
    return []
  }

  const key = `${file}@${mtime}:${size}:${limit}`
  if (cache.has(key)) return cache.get(key)

  const text = readTailText(file, size)
  if (!text) return []
  const lines = text.split('\n')
  const out =
    source === 'cursor' ? fromToolUse(lines, cwd, limit) : fromFunctionCalls(lines, cwd, limit)

  if (cache.size > 60) cache.clear()
  cache.set(key, out)
  return out
}

// 一句话摘要：给气泡用。例："改 src/main/sfx.js"
function stepText(step) {
  if (!step) return ''
  const v = step.verb || step.tool
  return step.target ? `${v} ${step.target}` : v
}

// WorkBuddy 的会话文件路径：~/.workbuddy/projects/<cwd 里的 / 换成 ->/<sessionId>.jsonl
function workbuddyFile(sessionId, cwd) {
  if (!sessionId) return ''
  const home = require('node:os').homedir()
  const slug = String(cwd || '')
    .replace(/^\//, '')
    .replace(/\//g, '-')
  const root = path.join(home, '.workbuddy', 'projects')
  if (slug) {
    const p = path.join(root, slug, sessionId + '.jsonl')
    if (fs.existsSync(p)) return p
  }
  // 兜底：在 projects 下找同名的会话文件
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const p = path.join(root, d.name, sessionId + '.jsonl')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* ignore */
  }
  return ''
}

module.exports = { stepsOf, stepText, describe, workbuddyFile }
