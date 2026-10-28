'use strict'

// 用 zlib 手写一个最小 PNG，避免为了一个托盘图标引入图形库。
// 画一只 Q 版鲸鱼：蓝色身体 + 白肚皮 + 眼睛 + 尾巴。

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const S = 64
const px = Buffer.alloc(S * S * 4, 0)

const BODY = [74, 144, 226, 255]
const BELLY = [235, 243, 255, 255]
const EYE = [30, 40, 60, 255]

function set(x, y, c) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  px[i] = c[0]
  px[i + 1] = c[1]
  px[i + 2] = c[2]
  px[i + 3] = c[3]
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

// 身体
ellipse(30, 36, 24, 17, BODY)
// 尾巴
for (let i = 0; i < 14; i++) {
  const t = i / 13
  const y1 = 30 - t * 16
  const y2 = 40 + t * 10
  for (let x = 50 + i; x < 52 + i; x++) {
    set(x, Math.round(y1), BODY)
    set(x, Math.round(y2), BODY)
  }
}
// 肚皮
ellipse(30, 42, 17, 10, BELLY)
// 眼睛
ellipse(18, 32, 3, 3, EYE)
ellipse(19, 31, 1, 1, [255, 255, 255, 255])
// 鳍
ellipse(40, 45, 6, 3, BODY)

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}

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

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, '..', 'assets', 'tray.png')
fs.writeFileSync(out, png)
console.log('已生成', out, png.length, 'bytes')
