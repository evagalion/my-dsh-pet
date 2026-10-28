'use strict'

// 提示音 / 提示语音：状态一变就播一下。
//   voice 模式 —— 系统 TTS（say）+ 提高音调，可爱萝莉音；可自定义台词
//   tone  模式 —— assets/sfx/<agent>-<event>.wav 合成音
// 两种都走系统进程，不经过渲染层：窗口没焦点也响，也不受 Chromium 自动播放限制
// （渲染层用 AudioContext 的话，没有用户手势会被挂起，桌宠恰好是无人值守的）。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { ASSETS_DIR } = require('./paths')

const IS_MAC = os.platform() === 'darwin'
const SAY = '/usr/bin/say'

// 「开始干活」只在真正从闲下来切过去时响，从"在想/在收尾"转过来不算新一轮，免得一直说话
const FRESH_START = new Set(['idle', 'success', 'error', 'waiting'])

let lastAt = 0
let prevPhase = 'idle'
let prevSource = 'none'
let armed = false // 刚启动那一下不响，免得每次开桌宠都来一句

function modeOf(cfg) {
  const s = (cfg && cfg.sound) || {}
  if (s.enabled === false) return 'off'
  return s.mode === 'tone' ? 'tone' : 'voice'
}

function canSpeak() {
  return IS_MAC && fs.existsSync(SAY)
}

// 台词模板：{agent} 换成 agent 名，{what} 换成正在处理的问题
function renderLine(tpl, cfg, s) {
  if (!tpl) return ''
  const agent = ((cfg.agents || {})[s && s.source] || {}).label || ''
  let what = (s && (s.title || s.project)) || ''
  what = String(what).slice(0, 10)
  return String(tpl)
    .replace(/\{agent\}/g, agent)
    .replace(/\{what\}/g, what)
    .trim()
}

function speak(cfg, s, event, force) {
  if (!canSpeak()) return false
  const v = ((cfg && cfg.sound) || {}).voice || {}
  const text = renderLine((v.lines || {})[event], cfg, s)
  if (!text) return false

  const name = v.name || 'Meijia'
  const rate = v.rate == null ? 200 : v.rate
  const pitch = v.pitch == null ? 90 : v.pitch
  const vol = (cfg.sound && cfg.sound.volume) == null ? 0.35 : cfg.sound.volume
  if (!force && Date.now() - lastAt < gapOf(cfg)) return false
  lastAt = Date.now()

  // [[pbas +N]] 抬高音调（稚嫩感），[[volm]] 控音量
  const script = `[[pbas +${pitch}]] [[volm ${vol}]] ${text}`
  execFile(SAY, ['-v', name, '-r', String(rate), script], { timeout: 15000 }, () => {})
  return true
}

function tone(cfg, source, event, force) {
  if (!IS_MAC) return false
  const p = path.join(ASSETS_DIR, 'sfx', `${source}-${event}.wav`)
  const file = fs.existsSync(p)
    ? p
    : path.join(ASSETS_DIR, 'sfx', `workbuddy-${event}.wav`) // 未知来源退回 WorkBuddy 音色
  if (!fs.existsSync(file)) return false
  if (!force && Date.now() - lastAt < gapOf(cfg)) return false
  lastAt = Date.now()

  const vol = String((cfg.sound && cfg.sound.volume) == null ? 0.35 : cfg.sound.volume)
  execFile('afplay', ['-v', vol, file], { timeout: 5000 }, () => {})
  return true
}

function gapOf(cfg) {
  const g = cfg && cfg.sound && cfg.sound.minGapMs
  return g == null ? 6000 : g
}

function play(cfg, s) {
  const mode = modeOf(cfg)
  if (mode === 'off' || !s || !s.phase) {
    prevPhase = (s && s.phase) || 'idle'
    prevSource = (s && s.source) || 'none'
    armed = true
    return false
  }

  if (s.phase === 'idle') {
    prevPhase = 'idle'
    prevSource = s.source || 'none'
    armed = true // 启动时的空闲态也算"已就位"，别把第一次真正的干活声吃掉
    return false
  }

  const event = ((cfg.sound || {}).on || {})[s.phase]
  const changed = s.phase !== prevPhase || s.source !== prevSource
  const prev = prevPhase
  const first = !armed
  armed = true
  prevPhase = s.phase
  prevSource = s.source || 'none'
  if (!event || !changed || first) return false

  // working 只认"新一轮"，thinking/organizing 之间来回切不响
  if (s.phase === 'working' && !FRESH_START.has(prev)) return false

  if (mode === 'voice' && canSpeak()) return speak(cfg, s, event)
  return tone(cfg, s.source || 'workbuddy', event) // 语音不可用就退回音效
}

// 菜单里切换模式后立刻来一句，让用户听效果（跳过节流和状态机）
function preview(cfg) {
  const mode = modeOf(cfg)
  if (mode === 'off') return false
  const sample = { source: 'workbuddy', phase: 'success' }
  if (mode === 'voice' && canSpeak()) return speak(cfg, sample, 'done', true)
  return tone(cfg, 'workbuddy', 'done', true)
}

module.exports = { play, preview, modeOf }
