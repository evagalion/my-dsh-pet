#!/usr/bin/env node
'use strict'

// 预热语音缓存：把配置里所有台词 × 所有 agent 组合提前合成一遍。
// 做过一次之后，桌宠播报就完全不需要联网了（Edge 引擎是联网合成的）。
// 换个音色 / 改了台词 / 想强制重录时跑一下：
//     node scripts/warm-voice.js          # 只补缺失的
//     node scripts/warm-voice.js --force  # 全部重录

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/pet.config.json'), 'utf8'))
const v = (cfg.sound && cfg.sound.voice) || {}
const e = v.edge || {}

if (v.engine !== 'edge') {
  console.log('当前引擎是', v.engine, '（本地离线），不需要预热。')
  process.exit(0)
}

const FORCE = process.argv.includes('--force')
const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'dafeiyu-tts')
fs.mkdirSync(CACHE, { recursive: true })

const CODE = [
  'import sys, asyncio, edge_tts',
  'async def go():',
  '    await edge_tts.Communicate(sys.argv[4], sys.argv[1], rate=sys.argv[2], pitch=sys.argv[3]).save(sys.argv[5])',
  'asyncio.run(go())',
].join('\n')

// 找出配置里配了 python 的那个，否则用 PATH 里的
function pickPython() {
  const cands = [e.python, 'python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].filter(Boolean)
  for (const py of cands) {
    try {
      execFileSync(py, ['-c', 'import edge_tts'], { stdio: 'ignore' })
      return py
    } catch (_) {}
  }
  return null
}

const py = pickPython()
if (!py) {
  console.error('没找到装了 edge-tts 的 python。先跑：python3 -m pip install edge-tts')
  process.exit(1)
}

// 台词 × agent：{agent} 只在 start 里出现，其余几句三家共用
const lines = []
for (const [event, tpl] of Object.entries(v.lines || {})) {
  if (!tpl) continue
  if (String(tpl).includes('{agent}')) {
    for (const [src, a] of Object.entries(cfg.agents || {})) {
      lines.push([`${event}/${src}`, String(tpl).replace(/\{agent\}/g, a.label || src)])
    }
  } else {
    lines.push([event, String(tpl)])
  }
}

const voice = e.voice || 'zh-CN-XiaoyiNeural'
const rate = e.rate || '+10%'
const pitch = e.pitch || '+10Hz'
console.log(`音色：${voice}  rate=${rate}  pitch=${pitch}  python=${py}`)
console.log(`缓存目录：${CACHE}\n`)

let made = 0
let kept = 0
for (const [tag, text] of lines) {
  const key = crypto.createHash('md5').update(`${voice}|${rate}|${pitch}|${text}`).digest('hex').slice(0, 16)
  const out = path.join(CACHE, `edge-${key}.mp3`)
  if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 1024) {
    console.log(`  跳过（已有） ${tag}  「${text}」`)
    kept++
    continue
  }
  try {
    execFileSync(py, ['-c', CODE, voice, rate, pitch, text, out], { stdio: 'ignore', timeout: 30000 })
    const kb = Math.round(fs.statSync(out).size / 1024)
    console.log(`  合成 ${String(kb).padStart(3)}KB  ${tag}  「${text}」`)
    made++
  } catch (err) {
    console.error(`  失败  ${tag}  「${text}」：`, (err && err.message) || err)
  }
}

console.log(`\n完成：新合成 ${made} 条，沿用缓存 ${kept} 条。共 ${fs.readdirSync(CACHE).filter((f) => f.startsWith('edge-')).length} 条 Edge 缓存。`)
