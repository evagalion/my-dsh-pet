'use strict'

// 提示音 / 提示语音：状态一变就播一下。
//   voice 模式 —— 念台词。引擎按优先级回退：
//       edge  ：Edge 神经网络 TTS（微软在线音色，音质最好）。首次联网合成后
//               缓存到本地，之后完全离线播放；断网时自动回退下一档
//       kokoro：本地神经网络 TTS（sherpa-onnx + Kokoro-82M v1.1-zh），纯离线
//       vits  ：sherpa-onnx 的 VITS 系本地模型（MeloTTS / Theresa…），纯离线
//       say   ：macOS 系统 TTS + 提高音调（机械味重，最后兜底）
//   tone  模式 —— assets/sfx/<agent>-<event>.wav 合成音
// 全部走系统进程，不经过渲染层：窗口没焦点也响，也不受 Chromium 自动播放限制
// （渲染层用 AudioContext 的话，没有用户手势会被挂起，桌宠恰好是无人值守的）。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFile, spawnSync } = require('node:child_process')
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

// engine: edge | kokoro | vits | say
//   edge —— 在线神经网络，音质最好，台词缓存后可离线播放
//   kokoro / vits —— 本地离线神经网络（vits 泛指 sherpa-onnx 的 VITS 系模型：MeloTTS / Theresa…）
function engineOf(cfg) {
  const e = String(voiceCfg(cfg).engine || '')
  return e === 'edge' || e === 'kokoro' || e === 'vits' ? e : 'say'
}

// ---- Edge 在线神经 TTS ----

// 打包版从 Finder 启动时 PATH 很窄，所以配置里写死绝对路径；找不到再逐个探测
function edgeCandidates(cfg) {
  return [
    (voiceCfg(cfg).edge || {}).python,
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ].filter(Boolean)
}

let edgePyCache = null // null=还没探测 ''=探测过但没有可用的
function edgePython(cfg) {
  if (edgePyCache != null) return edgePyCache
  for (const py of edgeCandidates(cfg)) {
    try {
      const r = spawnSync(py, ['-c', 'import edge_tts'], { timeout: 15000 })
      if (r.status === 0) {
        edgePyCache = py
        return py
      }
    } catch (e) {
      /* 这个候选不可用，换下一个 */
    }
  }
  edgePyCache = ''
  return ''
}

// 探测结果会被缓存，改了配置（换 python 路径）要能重来
function resetEdgeProbe() {
  edgePyCache = null
}

// 启动时异步预热探测，免得第一次播报时同步 spawn 卡住主线程（动画会顿半秒）。
// 用的是异步 execFile，探测过程不阻塞
function warmup(cfg) {
  if (engineOf(cfg) !== 'edge' || edgePyCache != null) return
  const cands = edgeCandidates(cfg)
  const tryNext = (i) => {
    if (i >= cands.length) {
      edgePyCache = ''
      return
    }
    const py = cands[i]
    execFile(py, ['-c', 'import edge_tts'], { timeout: 15000 }, (err) => {
      if (!err) {
        edgePyCache = py
        return
      }
      tryNext(i + 1)
    })
  }
  tryNext(0)
}

function edgeAvailable(cfg) {
  return engineOf(cfg) === 'edge' && !!edgePython(cfg)
}

// 一行内联脚本，避免打包时漏拷 scripts/ 下的 py 文件
const EDGE_CODE = [
  'import sys, asyncio, edge_tts',
  'async def go():',
  '    await edge_tts.Communicate(sys.argv[4], sys.argv[1], rate=sys.argv[2], pitch=sys.argv[3]).save(sys.argv[5])',
  'asyncio.run(go())',
].join('\n')

function edgeSpeak(cfg, text, force, onFail) {
  const py = edgePython(cfg)
  if (!py) return false
  if (!force && Date.now() - lastAt < gapOf(cfg)) return false
  lastAt = Date.now()

  const e = voiceCfg(cfg).edge || {}
  const voice = e.voice || 'zh-CN-XiaoyiNeural'
  const rate = e.rate || '+10%'
  const pitch = e.pitch || '+10Hz'

  const key = crypto
    .createHash('md5')
    .update(`${voice}|${rate}|${pitch}|${text}`)
    .digest('hex')
    .slice(0, 16)
  const out = path.join(ttsCacheDir(), `edge-${key}.mp3`)
  const vol = String(volOf(cfg))

  const playOut = (f) => execFile('afplay', ['-v', vol, f], { timeout: 20000 }, () => {})
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    playOut(out)
    return true
  }

  execFile(
    py,
    ['-c', EDGE_CODE, voice, rate, pitch, text, out],
    { timeout: 30000 },
    (err) => {
      if (err || !fs.existsSync(out) || fs.statSync(out).size <= 1024) {
        console.error('[pet] Edge 合成失败（多半是没网），回退下一档引擎：', (err && err.message) || '没有输出文件')
        if (typeof onFail === 'function') onFail()
        return
      }
      playOut(out)
    }
  )
  return true
}

// 解析出二进制与模型路径；缺任何一个就返回 ok:false，上层自动退回 say
function kokoroPaths(cfg) {
  const v = voiceCfg(cfg)
  const k = v.tts || v.kokoro || {}
  const dir = k.dir ? path.resolve(ROOT, k.dir) : path.join(ASSETS_DIR, 'tts', 'kokoro-multi-lang-v1_1')
  const bin = k.bin
    ? path.resolve(ROOT, k.bin)
    : path.join(ASSETS_DIR, 'tts', 'sherpa-onnx-v2.0.1-osx-arm64-shared', 'bin', 'sherpa-onnx-offline-tts')

  // 不写 kind 就从目录名猜：带 kokoro 走 kokoro 参数，其余走 vits 参数
  const kind = k.kind || (/kokoro/i.test(dir) ? 'kokoro' : 'vits')
  const model = k.model || 'model.onnx'
  const sid = k.sid == null ? 0 : k.sid

  const need =
    kind === 'kokoro'
      ? ['model.onnx', 'voices.bin', 'tokens.txt']
      : [model, 'tokens.txt', 'lexicon.txt']
  const ok = !!bin && fs.existsSync(bin) && need.every((f) => fs.existsSync(path.join(dir, f)))

  return {
    ok,
    kind,
    bin,
    dir,
    model,
    sid,
    speed: k.speed == null ? 1 : k.speed,
    threads: k.numThreads == null ? 2 : k.numThreads,
    label: k.label || `${path.basename(dir)}#${sid}`,
  }
}

function kokoroAvailable(cfg) {
  const e = engineOf(cfg)
  return (e === 'kokoro' || e === 'vits') && kokoroPaths(cfg).ok
}

// 两类模型参数不一样：kokoro 要 voices.bin + espeak-ng-data，vits 要 lexicon
function kokoroArgs(p, text, out) {
  const common = [
    `--num-threads=${p.threads}`,
    `--sid=${p.sid}`,
    `--speed=${p.speed}`,
    `--output-filename=${out}`,
    text,
  ]
  if (p.kind === 'kokoro') {
    return [
      `--kokoro-model=${path.join(p.dir, 'model.onnx')}`,
      `--kokoro-voices=${path.join(p.dir, 'voices.bin')}`,
      `--kokoro-tokens=${path.join(p.dir, 'tokens.txt')}`,
      `--kokoro-data-dir=${path.join(p.dir, 'espeak-ng-data')}`,
      `--kokoro-lexicon=${path.join(p.dir, 'lexicon-us-en.txt')},${path.join(p.dir, 'lexicon-zh.txt')}`,
      `--tts-rule-fsts=${path.join(p.dir, 'date-zh.fst')},${path.join(p.dir, 'number-zh.fst')}`,
      ...common,
    ]
  }
  const args = [
    `--vits-model=${path.join(p.dir, p.model)}`,
    `--vits-tokens=${path.join(p.dir, 'tokens.txt')}`,
    `--vits-lexicon=${path.join(p.dir, 'lexicon.txt')}`,
  ]
  const fsts = [path.join(p.dir, 'date.fst'), path.join(p.dir, 'number.fst')].filter((f) =>
    fs.existsSync(f)
  )
  if (fsts.length) args.push(`--tts-rule-fsts=${fsts.join(',')}`)
  return args.concat(common)
}

// 台词就那几句，合成一次缓存起来，之后就是秒播（否则每次都要等 1~2 秒才出声）。
// 放 Caches 而不是 tmpdir：重启后缓存还在，等于合成过一次就永久离线可用。
function ttsCacheDir() {
  const cands = IS_MAC
    ? [path.join(os.homedir(), 'Library', 'Caches', 'dafeiyu-tts'), path.join(os.tmpdir(), 'dafeiyu-tts')]
    : [path.join(os.tmpdir(), 'dafeiyu-tts')]
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true })
      return d
    } catch (e) {
      /* 这个目录建不了就换下一个 */
    }
  }
  return os.tmpdir()
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

// 回退链：edge（在线，音质最好）→ kokoro/vits（本地离线）→ say（系统兜底）
function speak(cfg, s, event, force) {
  const v = voiceCfg(cfg)
  const text = renderLine((v.lines || {})[event], cfg, s)
  if (!text) return false

  const engine = engineOf(cfg)
  if (engine === 'edge' && edgeAvailable(cfg)) {
    if (edgeSpeak(cfg, text, force, () => localSpeak(cfg, text, true))) return true
  }
  if (engine !== 'say' && speakKokoro(cfg, text, force)) return true

  if (!canSpeak()) return false
  if (!force && Date.now() - lastAt < gapOf(cfg)) return false
  lastAt = Date.now()
  return sayFallback(cfg, text)
}

// Edge 用不了时的本地兜底：先本地神经 TTS，再系统 say。force=true 跳过节流，
// 因为这是被上层判定"该说一句"之后的回退，不是重复触发
function localSpeak(cfg, text, force) {
  if (speakKokoro(cfg, text, force)) return true
  if (!canSpeak()) return false
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

// ---- 点击音效 ----
// 音效包机制（参考 dsh-pet-indesktop）：assets/sfx/click/ 下所有音频都算一个「包」，
// 点击时随机挑一个播。想加音效就往目录里丢 wav/mp3，不用改代码。
const CLICK_EXTS = /\.(wav|mp3|m4a|ogg|flac|aac)$/i

let lastClickAt = 0
let lastClickFile = ''

function clickDir() {
  return path.join(ASSETS_DIR, 'sfx', 'click')
}

function clickFiles() {
  try {
    return fs
      .readdirSync(clickDir())
      .filter((f) => CLICK_EXTS.test(f))
      .sort()
  } catch (e) {
    return []
  }
}

// 摸一下/点一下时播。跟状态播报分开：这个要跟手，节流给得很短
function click(cfg, force) {
  const c = (cfg && cfg.sound && cfg.sound.click) || {}
  if (c.enabled === false) return false
  const files = clickFiles()
  if (!files.length) return false

  const now = Date.now()
  const gap = c.minGapMs == null ? 200 : c.minGapMs
  if (!force && now - lastClickAt < gap) return false // 连点时别糊成一片
  lastClickAt = now

  // 随机挑一个，尽量不连着放同一个
  let pool = files
  if (files.length > 1) {
    const rest = files.filter((f) => f !== lastClickFile)
    if (rest.length) pool = rest
  }
  const f = pool[Math.floor(Math.random() * pool.length)]
  lastClickFile = f

  const vol = String(c.volume == null ? 0.5 : c.volume)
  execFile('afplay', ['-v', vol, path.join(clickDir(), f)], { timeout: 8000 }, () => {})
  return true
}

function clickAvailable() {
  return clickFiles().length > 0
}

function clickCount() {
  return clickFiles().length
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

  if (mode === 'voice' && (edgeAvailable(cfg) || kokoroAvailable(cfg) || canSpeak())) {
    return speak(cfg, s, event)
  }
  return tone(cfg, s.source || 'workbuddy', event) // 语音不可用就退回音效
}

// 菜单里切换模式后立刻来一句，让用户听效果（跳过节流和状态机）
function preview(cfg) {
  const mode = modeOf(cfg)
  if (mode === 'off') return false
  const sample = { source: 'workbuddy', phase: 'success' }
  if (mode === 'voice' && (edgeAvailable(cfg) || kokoroAvailable(cfg) || canSpeak())) {
    return speak(cfg, sample, 'done', true)
  }
  return tone(cfg, 'workbuddy', 'done', true)
}

// 菜单上显示当前走的是哪个引擎
function voiceLabel(cfg) {
  const e = engineOf(cfg)
  if (e === 'edge') {
    const ed = voiceCfg(cfg).edge || {}
    const label = ed.label || String(ed.voice || '').replace(/^zh-CN-/, '').replace('Neural', '')
    return edgeAvailable(cfg) ? `Edge·${label}` : `Edge·${label}（没装 edge-tts，已退回本地）`
  }
  if (e !== 'say') {
    const p = kokoroPaths(cfg)
    return p.ok ? p.label : `${p.label}（缺文件，已退回系统语音）`
  }
  return voiceCfg(cfg).name || 'Meijia'
}

// 试听页路径（挑音色用），不存在返回 null。优先 Edge 那页
function auditionPath() {
  const edge = path.join(ASSETS_DIR, 'tts', 'edge-audition.html')
  if (fs.existsSync(edge)) return edge
  const p = path.join(ASSETS_DIR, 'tts', 'audition.html')
  return fs.existsSync(p) ? p : null
}

module.exports = {
  play,
  preview,
  modeOf,
  voiceLabel,
  auditionPath,
  engineOf,
  kokoroAvailable,
  edgeAvailable,
  resetEdgeProbe,
  warmup,
  click,
  clickAvailable,
  clickCount,
}
