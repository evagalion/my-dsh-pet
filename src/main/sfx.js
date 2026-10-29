'use strict'

// 提示音 / 提示语音：状态一变就播一下。
//   voice 模式 —— 念台词。引擎二选一：
//       kokoro：本地神经网络 TTS（sherpa-onnx + Kokoro-82M v1.1-zh），自然得多，
//               55 个中文女声可选，首次合成约 1~2 秒，之后走缓存秒播
//       say   ：macOS 系统 TTS + 提高音调（机械味重，作为兜底）
//   tone  模式 —— assets/sfx/<agent>-<event>.wav 合成音
// 全部走系统进程，不经过渲染层：窗口没焦点也响，也不受 Chromium 自动播放限制
// （渲染层用 AudioContext 的话，没有用户手势会被挂起，桌宠恰好是无人值守的）。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { ASSETS_DIR, ROOT } = require('./paths')

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

// ---- Kokoro 本地神经 TTS ----

function voiceCfg(cfg) {
  return ((cfg && cfg.sound && cfg.sound.voice) || {})
}

function engineOf(cfg) {
  return voiceCfg(cfg).engine === 'kokoro' ? 'kokoro' : 'say'
}

// 解析出 kokoro 的二进制与模型路径；缺任何一个就返回 ok:false，上层自动退回 say
function kokoroPaths(cfg) {
  const k = voiceCfg(cfg).kokoro || {}
  const dir = k.dir ? path.resolve(ROOT, k.dir) : path.join(ASSETS_DIR, 'tts', 'kokoro-multi-lang-v1_1')
  const bin = k.bin
    ? path.resolve(ROOT, k.bin)
    : path.join(ASSETS_DIR, 'tts', 'sherpa-onnx-v2.0.1-osx-arm64-shared', 'bin', 'sherpa-onnx-offline-tts')
  const ok =
    fs.existsSync(bin) &&
    fs.existsSync(path.join(dir, 'model.onnx')) &&
    fs.existsSync(path.join(dir, 'voices.bin')) &&
    fs.existsSync(path.join(dir, 'tokens.txt'))
  return {
    ok,
    bin,
    dir,
    sid: k.sid == null ? 3 : k.sid,
    speed: k.speed == null ? 1 : k.speed,
    threads: k.numThreads == null ? 2 : k.numThreads,
    label: k.label || `Kokoro#${k.sid == null ? 3 : k.sid}`,
  }
}

function kokoroAvailable(cfg) {
  return engineOf(cfg) === 'kokoro' && kokoroPaths(cfg).ok
}

function kokoroArgs(p, text, out) {
  return [
    `--kokoro-model=${path.join(p.dir, 'model.onnx')}`,
    `--kokoro-voices=${path.join(p.dir, 'voices.bin')}`,
    `--kokoro-tokens=${path.join(p.dir, 'tokens.txt')}`,
    `--kokoro-data-dir=${path.join(p.dir, 'espeak-ng-data')}`,
    `--kokoro-lexicon=${path.join(p.dir, 'lexicon-us-en.txt')},${path.join(p.dir, 'lexicon-zh.txt')}`,
    `--tts-rule-fsts=${path.join(p.dir, 'date-zh.fst')},${path.join(p.dir, 'number-zh.fst')}`,
    `--num-threads=${p.threads}`,
    `--sid=${p.sid}`,
    `--speed=${p.speed}`,
    `--output-filename=${out}`,
    text,
  ]
}

// 台词就那几句，合成一次缓存起来，之后就是秒播（否则每次都要等 1~2 秒才出声）
function ttsCacheDir() {
  return path.join(os.tmpdir(), 'dafeiyu-tts')
}

function speakKokoro(cfg, text, force) {
  const p = kokoroPaths(cfg)
  if (!p.ok) return false
  if (!force && Date.now() - lastAt < gapOf(cfg)) return false
  lastAt = Date.now()

  const key = crypto.createHash('md5').update(`${p.sid}|${p.speed}|${text}`).digest('hex').slice(0, 16)
  const out = path.join(ttsCacheDir(), `${key}.wav`)
  const vol = String(volOf(cfg))

  const playOut = () => execFile('afplay', ['-v', vol, out], { timeout: 20000 }, () => {})
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    playOut()
    return true
  }

  try {
    fs.mkdirSync(ttsCacheDir(), { recursive: true })
  } catch (e) {
    /* 建不了缓存目录就退回 say */
    return false
  }
  execFile(p.bin, kokoroArgs(p, text, out), { timeout: 60000 }, (err) => {
    if (err || !fs.existsSync(out)) {
      console.error('[pet] Kokoro 合成失败，退回系统 say：', (err && err.message) || '没有输出文件')
      sayFallback(cfg, text)
      return
    }
    playOut()
  })
  return true
}

function sayFallback(cfg, text) {
  if (!canSpeak()) return false
  const v = voiceCfg(cfg)
  const name = v.name || 'Meijia'
  const rate = v.rate == null ? 200 : v.rate
  const pitch = v.pitch == null ? 90 : v.pitch
  execFile(
    SAY,
    ['-v', name, '-r', String(rate), `[[pbas +${pitch}]] [[volm ${volOf(cfg)}]] ${text}`],
    { timeout: 15000 },
    () => {}
  )
  return true
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
  const v = voiceCfg(cfg)
  const text = renderLine((v.lines || {})[event], cfg, s)
  if (!text) return false

  if (engineOf(cfg) === 'kokoro' && speakKokoro(cfg, text, force)) return true

  if (!canSpeak()) return false
  if (!force && Date.now() - lastAt < gapOf(cfg)) return false
  lastAt = Date.now()
  return sayFallback(cfg, text)
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

function volOf(cfg) {
  const v = cfg && cfg.sound && cfg.sound.volume
  return v == null ? 0.35 : v
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

  if (mode === 'voice' && (kokoroAvailable(cfg) || canSpeak())) return speak(cfg, s, event)
  return tone(cfg, s.source || 'workbuddy', event) // 语音不可用就退回音效
}

// 菜单里切换模式后立刻来一句，让用户听效果（跳过节流和状态机）
function preview(cfg) {
  const mode = modeOf(cfg)
  if (mode === 'off') return false
  const sample = { source: 'workbuddy', phase: 'success' }
  if (mode === 'voice' && (kokoroAvailable(cfg) || canSpeak())) return speak(cfg, sample, 'done', true)
  return tone(cfg, 'workbuddy', 'done', true)
}

// 菜单上显示当前走的是哪个引擎
function voiceLabel(cfg) {
  if (engineOf(cfg) === 'kokoro') {
    const p = kokoroPaths(cfg)
    return p.ok ? p.label : `${p.label}（缺文件，已退回系统语音）`
  }
  return voiceCfg(cfg).name || 'Meijia'
}

// 试听页路径（挑音色用），不存在返回 null
function auditionPath() {
  const p = path.join(ASSETS_DIR, 'tts', 'audition.html')
  return fs.existsSync(p) ? p : null
}

module.exports = { play, preview, modeOf, voiceLabel, auditionPath, kokoroAvailable }
