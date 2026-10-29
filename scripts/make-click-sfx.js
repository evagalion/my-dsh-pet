'use strict'

// 合成「点击大肥鱼」的音效包，放在 assets/sfx/click/ 下，点击时随机挑一个播。
//
// 思路参考 MerZlin/dsh-pet-indesktop 的 scripts/make_click_sound.py：
// 短促的「Q 弹」感 = 一段快速下扫的主弹 + 一小段更轻更短的回弹。
// 主弹负责"被按下去"，回弹负责"弹起来"，两段叠起来就有果冻手感。
//
// 这里做了两处改进：
//   1. 扫频用真正的相位积分（ph += 2π·f/RATE），而不是 sin(2π·f(t)·t)。
//      后者瞬时频率其实是 f(t) + t·f'(t)，下扫会扫过头、音高飘，Q 弹感反而不准
//   2. 一次合成 4 种手感，点击时随机挑，比单一音效耐听
//
// 用法：node scripts/make-click-sfx.js

const fs = require('node:fs')
const path = require('node:path')

const RATE = 44100
const OUT_DIR = path.join(__dirname, '..', 'assets', 'sfx', 'click')

// 一段扫频音：f0 → f1 在 sweepMs 内扫完，整体指数衰减
function blip(buf, o) {
  const { at, dur, f0, f1, sweepMs, decay, gain, h2 = 0 } = o
  const start = Math.floor(at * RATE)
  const n = Math.floor(dur * RATE)
  const sweepSec = sweepMs / 1000
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const k = Math.min(1, t / sweepSec)
    const f = f0 + (f1 - f0) * k
    ph += (2 * Math.PI * f) / RATE // 相位积分，扫频才准
    // 4ms 淡入，避免开头爆音
    const attack = Math.min(1, t / 0.004)
    const env = attack * Math.exp(-decay * t)
    const s = Math.sin(ph) + h2 * Math.sin(2 * ph)
    buf[start + i] += s * env * gain
  }
}

function render(parts, gain) {
  const total = Math.max(...parts.map((p) => p.at + p.dur))
  const len = Math.ceil(total * RATE) + Math.ceil(0.05 * RATE)
  const buf = new Float32Array(len)
  for (const p of parts) blip(buf, p)

  // 归一化到 0.92，留点余量
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  const k = peak > 0 ? 0.92 / peak : 1

  const pcm = Buffer.alloc(len * 2)
  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, buf[i] * k))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  void gain
  return pcm
}

function wav(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // 单声道
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

// 每个音效 = 若干段扫频叠加
//   主弹 = 被按下去，回弹 = 弹起来（更轻、更短、更晚）
const CLICKS = {
  // Q 弹：参考项目的配方，最"果冻"
  bounce: [
    { at: 0, dur: 0.16, f0: 440, f1: 160, sweepMs: 80, decay: 22, gain: 1.0 },
    { at: 0.055, dur: 0.11, f0: 200, f1: 120, sweepMs: 60, decay: 38, gain: 0.55 },
  ],
  // 啵：短促上扬，像戳破气泡
  pop: [
    { at: 0, dur: 0.1, f0: 180, f1: 520, sweepMs: 45, decay: 30, gain: 1.0 },
    { at: 0.035, dur: 0.07, f0: 400, f1: 300, sweepMs: 40, decay: 45, gain: 0.35 },
  ],
  // 弹簧：下扫再弹上去再落回来，最夸张
  boing: [
    { at: 0, dur: 0.22, f0: 300, f1: 120, sweepMs: 60, decay: 14, gain: 1.0 },
    { at: 0.07, dur: 0.15, f0: 120, f1: 260, sweepMs: 50, decay: 20, gain: 0.6 },
    { at: 0.14, dur: 0.11, f0: 260, f1: 180, sweepMs: 40, decay: 26, gain: 0.35 },
  ],
  // 咔：极短极脆，摸得快的时候不糊
  tick: [{ at: 0, dur: 0.045, f0: 900, f1: 500, sweepMs: 12, decay: 90, gain: 1.0, h2: 0.45 }],
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const [name, parts] of Object.entries(CLICKS)) {
  const pcm = render(parts)
  const out = path.join(OUT_DIR, `${name}.wav`)
  fs.writeFileSync(out, wav(pcm))
  const ms = Math.round((pcm.length / 2 / RATE) * 1000)
  console.log(`已生成 ${path.relative(process.cwd(), out)}  ${ms}ms  ${pcm.length + 44} bytes`)
}
console.log(`共 ${Object.keys(CLICKS).length} 个点击音效 → ${path.relative(process.cwd(), OUT_DIR)}`)
console.log('想加自己的音效：把 wav/mp3 丢进这个目录就行，播放时会一起随机。')
