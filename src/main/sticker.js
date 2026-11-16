'use strict'

// 表情包生成器：抽当前动画的一帧，底下叠一句台词，导出 PNG 到「图片/大肥鱼表情包」。
// 放在主进程用隐藏窗口抽帧——渲染层的 pet:// 视频会污染 canvas，toDataURL 会抛错。

const { BrowserWindow, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { ASSETS_DIR } = require('./paths')

let win = null
let host = null

function ensureHost() {
  if (host && fs.existsSync(host)) return host
  host = path.join(require('node:os').tmpdir(), 'dsh-sticker-host.html')
  fs.writeFileSync(host, '<!doctype html><meta charset="utf-8"><body></body>')
  return host
}

// 在隐藏窗口里：加载视频 → 跳到中段 → 640x360 画布抽帧 → 下方叠台词条 → toDataURL
function buildFrame(anim, line) {
  const file = path.join(ASSETS_DIR, 'webm', anim)
  const url = 'file://' + file.split(path.sep).map(encodeURIComponent).join('/')
  const text = String(line || '').slice(0, 40)

  return win.webContents.executeJavaScript(`(async () => {
    const v = document.createElement('video')
    v.src = ${JSON.stringify(url)}
    v.muted = true
    await new Promise((res, rej) => {
      v.onloadedmetadata = res
      v.onerror = () => rej(new Error('视频加载失败'))
    })
    await new Promise((res) => { v.onseeked = res; v.currentTime = v.duration * 0.45 })
    const W = 640, H = 360, BAR = 108
    const c = document.createElement('canvas')
    c.width = W; c.height = H + BAR
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    // 白底（发聊天软件比透明底友好）
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, W, H + BAR)
    g.drawImage(v, 0, 0, W, H)
    // 台词条
    g.fillStyle = '#fffdf7'
    g.fillRect(0, H, W, BAR)
    g.fillStyle = '#e8e2d4'
    g.fillRect(0, H, W, 2)
    const text = ${JSON.stringify(text)}
    g.fillStyle = '#2c2c2a'
    g.font = '600 26px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    // 长台词拆两行
    const chars = Array.from(text)
    if (chars.length > 16) {
      const mid = Math.ceil(chars.length / 2)
      g.fillText(chars.slice(0, mid).join(''), W / 2, H + 34)
      g.fillText(chars.slice(mid).join(''), W / 2, H + 72)
    } else {
      g.fillText(text, W / 2, H + BAR / 2)
    }
    return c.toDataURL('image/png')
  })()`)
}

async function make(anim, line) {
  if (!anim) return { ok: false, error: '没有正在播放的动画' }
  if (!fs.existsSync(path.join(ASSETS_DIR, 'webm', anim))) {
    return { ok: false, error: '素材不存在：' + anim }
  }
  try {
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true, webSecurity: false, allowFileAccessFromFiles: true },
      })
      await win.loadFile(ensureHost())
    }
    const dataUrl = await buildFrame(anim, line)
    const dir = path.join(require('electron').app.getPath('pictures'), '大肥鱼表情包')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const out = path.join(dir, `大肥鱼-${stamp}.png`)
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
    shell.showItemInFolder(out)
    return { ok: true, file: out, dir, anim }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) }
  }
}

module.exports = { make }
