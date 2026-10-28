'use strict'

// 用 zlib 手写一个最小 PNG，避免为了几个图标引入图形库。
// 画一只 Q 版鲸鱼：蓝色身体 + 白肚皮 + 眼睛 + 尾巴。
// 画在 64x64 的坐标系里，再按 k 倍放大到目标尺寸（所以 1024 也是清晰的矢量式放大）。

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const BODY = [74, 144, 226, 255]
const BELLY = [235, 243, 255, 255]
const EYE = [30, 40, 60, 255]

const table = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  table[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function render(S) {
  const k = S / 64
  const px = Buffer.alloc(S * S * 4, 0)

  // 在 64 的坐标系里点一个格子，实际填 k×k 个像素
  function set(x, y, c) {
    const X0 = Math.floor(x * k)
    const Y0 = Math.floor(y * k)
    for (let dy = 0; dy < k; dy++) {
      for (let dx = 0; dx < k; dx++) {
        const X = X0 + dx
        const Y = Y0 + dy
        if (X < 0 || Y < 0 || X >= S || Y >= S) continue
        const i = (Y * S + X) * 4
        px[i] = c[0]
        px[i + 1] = c[1]
        px[i + 2] = c[2]
        px[i + 3] = c[3]
      }
    }
  }
  function ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) set(x, y, c)
      }
    }
  }

  ellipse(30, 36, 24, 17, BODY) // 身体
  for (let i = 0; i < 14; i++) {
    // 尾巴
    const t = i / 13
    const y1 = 30 - t * 16
    const y2 = 40 + t * 10
    for (let x = 50 + i; x < 52 + i; x++) {
      set(x, Math.round(y1), BODY)
      set(x, Math.round(y2), BODY)
    }
  }
  ellipse(30, 42, 17, 10, BELLY) // 肚皮
  ellipse(18, 32, 3, 3, EYE) // 眼睛
  ellipse(19, 31, 1, 1, [255, 255, 255, 255])
  ellipse(40, 45, 6, 3, BODY) // 鳍

  const raw = Buffer.alloc((S * 4 + 1) * S)
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const assets = path.join(__dirname, '..', 'assets')
const targets = [
  ['tray.png', 64],
  ['icon-1024.png', 1024],
]
for (const [name, size] of targets) {
  const buf = render(size)
  const out = path.join(assets, name)
  fs.writeFileSync(out, buf)
  console.log('已生成', out, buf.length, 'bytes')
}
