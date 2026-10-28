'use strict'

// 提示音：状态一变就播一小段合成音（assets/sfx/<agent>-<event>.wav）。
// 走系统播放器 afplay，不经过渲染层 —— 这样窗口没焦点、甚至被别的窗口盖住时也响，
// 而且绕开 Chromium 的自动播放限制（AudioContext 没有用户手势会被挂起）。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { ASSETS_DIR } = require('./paths')

const PLAYER = os.platform() === 'darwin' ? 'afplay' : null

// 「开始干活」只在真正从闲下来切过去时响，从"在想/在收尾"转过来不算新一轮，免得滴滴响个不停
const FRESH_START = new Set(['idle', 'success', 'error', 'waiting'])

let lastAt = 0
let prevPhase = 'idle'
let prevSource = 'none'
let armed = false // 刚启动那一下不响，免得每次开桌宠都"叮"一声

function fileFor(source, event) {
  const p = path.join(ASSETS_DIR, 'sfx', `${source}-${event}.wav`)
  if (fs.existsSync(p)) return p
  // 未知来源（比如 none）退回 WorkBuddy 的音色
  const fallback = path.join(ASSETS_DIR, 'sfx', `workbuddy-${event}.wav`)
  return fs.existsSync(fallback) ? fallback : null
}

// 返回是否真的播了，方便日志/自检
function play(cfg, s) {
  const cfgSound = (cfg && cfg.sound) || {}
  if (cfgSound.enabled === false || !PLAYER) return false
  if (!s || !s.phase || s.phase === 'idle') {
    prevPhase = s && s.phase ? s.phase : 'idle'
    prevSource = (s && s.source) || 'none'
    armed = true // 启动时的空闲态也算"已就位"，别把第一次真正的干活声吃掉
    return false
  }

  const event = (cfgSound.on || {})[s.phase]
  const changed = s.phase !== prevPhase || s.source !== prevSource
  const prev = prevPhase
  const first = !armed
  armed = true
  prevPhase = s.phase
  prevSource = s.source || 'none'
  if (!event || !changed || first) return false

  // working 只认"新一轮"，thinking/organizing 之间来回切不响
  if (s.phase === 'working' && !FRESH_START.has(prev)) return false

  const now = Date.now()
  const gap = cfgSound.minGapMs == null ? 6000 : cfgSound.minGapMs
  if (now - lastAt < gap) return false

  const file = fileFor(s.source || 'workbuddy', event)
  if (!file) return false

  lastAt = now
  const vol = String(cfgSound.volume == null ? 0.35 : cfgSound.volume)
  execFile(PLAYER, ['-v', vol, file], { timeout: 5000 }, () => {})
  return true
}

module.exports = { play }
