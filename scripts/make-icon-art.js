'use strict'

// 从 webm 素材抽一帧生成 app 图标，让图标跟桌宠实际形象一致。
// 用法: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/make-icon-art.js --no-sandbox --disable-gpu
// 产物: assets/icon-1024.png（Dock/应用图标，圆角浅蓝底 + 整身立绘）
//       assets/tray.png（菜单栏，脸部特写圆形，18pt 下也要认得出）
// 之后用 sips + iconutil 出 assets/icon.icns。

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'assets', 'webm', '点击回应-元气挥手.webm')
const ASSETS = path.join(__dirname, '..', 'assets')
const FRAME_T = 0.5 // 挥手动作最舒展的那一帧

// ---------- 在页面里抽帧并算 alpha 包围盒 ----------
const CAPTURE = `(async () => {
  const v = document.createElement('video')
  v.src = ${JSON.stringify('file://' + SRC.split(path.sep).map(encodeURIComponent).join('/'))}
  v.muted = true
  await new Promise((res, rej) => {
    v.onloadedmetadata = res
    v.onerror = () => rej(new Error('load fail'))
  })
  await new Promise((res) => { v.onseeked = res; v.currentTime = v.duration * ${FRAME_T} })
  const W = 640, H = 360
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  c.getContext('2d').drawImage(v, 0, 0, W, H)
  const d = c.getContext('2d').getImageData(0, 0, W, H).data
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (d[(y * W + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) throw new Error('empty frame')
  return { box: [x0, y0, x1, y1], w: W, h: H, frame: c.toDataURL('image/png') }
})()`

// 合成：在渲染进程里做（主进程没有 canvas）
function composeCode(box, w, h, frameUrl) {
  return `(async () => {
    const im = new Image()
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = ${JSON.stringify(frameUrl)} })
    const src = document.createElement('canvas')
    src.width = im.width; src.height = im.height
    src.getContext('2d').drawImage(im, 0, 0)

    const [x0, y0, x1, y1] = ${JSON.stringify(box)}
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    const cx = ((x0 + x1) / 2 / ${w}) * im.width
    const sy = (y0 / ${h}) * im.height

    // —— app 图标：圆角浅蓝渐变底 + 整身立绘贴底，占高约 86% ——
    const S = 1024
    const out = document.createElement('canvas')
    out.width = S; out.height = S
    const g = out.getContext('2d')
    g.imageSmoothingQuality = 'high'
    const R = S * 0.224
    const grad = g.createLinearGradient(0, 0, 0, S)
    grad.addColorStop(0, '#eaf5ff')
    grad.addColorStop(0.55, '#c8e3ff')
    grad.addColorStop(1, '#9cc6f2')
    const round = () => { g.beginPath(); g.roundRect(0, 0, S, S, R) }
    round(); g.fillStyle = grad; g.fill()
    const hl = g.createLinearGradient(0, 0, 0, S * 0.5)
    hl.addColorStop(0, 'rgba(255,255,255,0.5)')
    hl.addColorStop(1, 'rgba(255,255,255,0)')
    round(); g.fillStyle = hl; g.fill()
    const drawH = S * 0.86
    const k = drawH / bh
    const dw = bw * k
    g.drawImage(src, cx - bw / 2, sy, bw, bh, (S - dw) / 2, S * 0.97 - drawH, dw, drawH)

    // —— 托盘：脸部特写圆形（头约占包围盒上部 62%）——
    const T = 128
    const tr = document.createElement('canvas')
    tr.width = T; tr.height = T
    const tg = tr.getContext('2d')
    tg.imageSmoothingQuality = 'high'
    const headH = bh * 0.62
    const side = headH * 1.02
    const hx = cx, hy = sy + headH * 0.48
    tg.beginPath(); tg.arc(T / 2, T / 2, T / 2 - 2, 0, Math.PI * 2)
    tg.fillStyle = '#dceeff'; tg.fill()
    tg.save(); tg.clip()
    tg.drawImage(src, hx - side / 2, hy - side / 2, side, side, 0, 0, T, T)
    tg.restore()
    tg.lineWidth = T * 0.045
    tg.strokeStyle = 'rgba(255,255,255,0.9)'
    tg.beginPath(); tg.arc(T / 2, T / 2, T / 2 - 2, 0, Math.PI * 2); tg.stroke()

    return { icon: out.toDataURL('image/png'), tray: tr.toDataURL('image/png') }
  })()`
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync('/tmp/dsh-icon-')
  const host = path.join(tmp, 'host.html')
  fs.writeFileSync(host, '<!doctype html><meta charset="utf-8"><body></body>')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, webSecurity: false, allowFileAccessFromFiles: true },
  })
  await win.loadFile(host)

  const { box, w, h, frame } = await win.webContents.executeJavaScript(CAPTURE)
  console.log('包围盒', box.join(','))

  const r = await win.webContents.executeJavaScript(composeCode(box, w, h, frame))
  fs.writeFileSync(path.join(ASSETS, 'icon-1024.png'), Buffer.from(r.icon.split(',')[1], 'base64'))
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), Buffer.from(r.tray.split(',')[1], 'base64'))
  console.log('已生成', path.join(ASSETS, 'icon-1024.png'))
  console.log('已生成', path.join(ASSETS, 'tray.png'))
  app.exit(0)
})
