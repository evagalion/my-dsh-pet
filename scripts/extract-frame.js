// 从 webm 素材里抽帧，裁到 alpha 包围盒，输出正方形 PNG 候选图
// 用法: ./node_modules/.bin/electron scripts/extract-frame.js --no-sandbox --disable-gpu
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'assets', 'webm')
const OUT = process.env.OUT || '/tmp/frames'
fs.mkdirSync(OUT, { recursive: true })

// 候选：能代表「大肥鱼」形象的几个素材
const TARGETS = [
  '待机呼吸休闲',
  '原地漂浮踏步',
  '悠闲哼歌',
  '蓝鲸现世',
  '鲸鱼吐泡泡特效',
  '点击回应-元气挥手',
  '点击回应-开心跃动',
  '小幅度原地360度旋转展示',
  '东张西望',
]

const JS = (srcPath, frac) => `(async () => {
  const v = document.createElement('video')
  v.src = ${JSON.stringify(srcPath)}
  v.muted = true
  await new Promise((res, rej) => {
    v.onloadedmetadata = res
    v.onerror = () => rej(new Error('load fail'))
  })
  await new Promise((res) => { v.onseeked = res; v.currentTime = v.duration * ${frac} })
  const W = 640, H = 360
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  c.getContext('2d').drawImage(v, 0, 0, W, H)
  const d = c.getContext('2d').getImageData(0, 0, W, H).data
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  // 裁成以包围盒为准的正方形，留 6% 边距
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  let side = Math.max(x1 - x0 + 1, y1 - y0 + 1)
  side = side / 0.88
  const S = 512
  const out = document.createElement('canvas')
  out.width = S; out.height = S
  const g = out.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(c, cx - side / 2, cy - side / 2, side, side, 0, 0, S, S)
  return { url: out.toDataURL('image/png'), box: [x0, y0, x1, y1] }
})()`

app.whenReady().then(async () => {
  // 必须落在真实 file:// 页面里，data: URL 是 opaque origin，加载不了本地视频
  const html = path.join(OUT, '_host.html')
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><body></body>')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, webSecurity: false, allowFileAccessFromFiles: true },
  })
  await win.loadFile(html)
  const rows = []
  for (const name of TARGETS) {
    const p = path.join(SRC, name + '.webm')
    if (!fs.existsSync(p)) {
      console.log('MISS', name)
      continue
    }
    const url = 'file://' + p.split(path.sep).map(encodeURIComponent).join('/')
    for (const frac of [0.2, 0.5, 0.8]) {
      try {
        const r = await win.webContents.executeJavaScript(JS(url, frac))
        if (!r) {
          console.log('EMPTY', name, frac)
          continue
        }
        const file = `${name}-${frac}.png`.replace(/\//g, '_')
        fs.writeFileSync(path.join(OUT, file), Buffer.from(r.url.split(',')[1], 'base64'))
        rows.push({ file, name, frac, box: r.box })
        console.log('OK', file, 'box=', r.box.join(','))
      } catch (e) {
        console.log('FAIL', name, frac, e.message)
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(rows, null, 2))
  console.log('DONE', rows.length, '->', OUT)
  app.exit(0)
})
