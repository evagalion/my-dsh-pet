'use strict'

// 手写 WAV 合成提示音，避免引入音频库或第三方素材（也就没有版权问题）。
// 每个音 = 基频 + 二次/三次泛音，配指数衰减包络，听起来像小铃铛。
// 三个 agent 用不同的基频和泛音配比，闭着眼也能听出是谁在动。

const fs = require('node:fs')
const path = require('node:path')

const RATE = 44100
const OUT_DIR = path.join(__dirname, '..', 'assets', 'sfx')

// 音色：基频 + 泛音增益（二次泛音越多越"亮"，三次多则偏"闷/木"）
const AGENTS = {
  workbuddy: { base: 620, h2: 0.34, h3: 0.1 }, // 温和的中音
  cursor: { base: 760, h2: 0.5, h3: 0.12 }, // 亮一点
  codebuddy: { base: 500, h2: 0.2, h3: 0.28 }, // 低一点、偏木
}

// 事件：每个音符 = [相对基频的倍数, 起始秒, 时长秒]
const EVENTS = {
  // 开始干活：短促上扬的"叮咚"
  start: [
    [1, 0, 0.14],
    [1.5, 0.085, 0.16],
  ],
  // 搞定：三音上行
  done: [
    [1, 0, 0.2],
    [1.25, 0.11, 0.2],
    [1.5, 0.22, 0.3],
  ],
  // 出错：两音下行
  error: [
    [1, 0, 0.26],
    [0.75, 0.17, 0.34],
  ],
  // 等你确认：门铃式两声
  waiting: [
    [1, 0, 0.18],
    [1, 0.26, 0.24],
  ],
}

function synth(notes, tone, gain) {
  const total = Math.max(...notes.map((n) => n[1] + n[2]))
  const len = Math.ceil(total * RATE) + Math.ceil(0.12 * RATE) // 尾巴留一点余韵
  const buf = new Float32Array(len)

  for (const [mul, at, dur] of notes) {
    const f = tone.base * mul
    const start = Math.floor(at * RATE)
    const n = Math.floor(dur * RATE)
    const decay = 5.5 / dur // 时长内衰减到 ~e^-5.5
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      // 5ms 淡入，避免爆音
      const attack = Math.min(1, t / 0.005)
      const env = attack * Math.exp(-decay * t)
      const ph = 2 * Math.PI * f * t
      const s =
        Math.sin(ph) + tone.h2 * Math.sin(2 * ph) + tone.h3 * Math.sin(3 * ph)
      buf[start + i] += s * env * gain
    }
  }

  // 归一化到 0.9，留点余量
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  const k = peak > 0 ? 0.9 / peak : 1

  const pcm = Buffer.alloc(len * 2)
  for (let i = 0; i < len; i++) {
    let v = buf[i] * k
    v = Math.max(-1, Math.min(1, v))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return pcm
}

function wav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk 长度
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

fs.mkdirSync(OUT_DIR, { recursive: true })
let count = 0
for (const [agent, tone] of Object.entries(AGENTS)) {
  for (const [event, notes] of Object.entries(EVENTS)) {
    const pcm = synth(notes, tone, 0.6)
    const out = path.join(OUT_DIR, `${agent}-${event}.wav`)
    fs.writeFileSync(out, wav(pcm))
    count++
    console.log('已生成', path.relative(process.cwd(), out), pcm.length + 44, 'bytes')
  }
}
console.log(`共 ${count} 个音效`)
