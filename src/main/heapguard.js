'use strict'

// 主进程内存自监控 + 保守自动回收。
//
// 背景（2026-11-27）：主进程 footprint 曾在某次动作后一次性从 78MB 跳到 1405MB，
// 之后 20 小时稳定不回落。footprint 分解显示 app-specific tag 16（V8 JS 堆）占 1202MB，
// vmmap 里 SWAPPED 1.3G——是 V8 分配后不归还 OS 的高水位，不是持续泄漏。
// 打包版进程无法挂调试器拿堆快照，所以用进程内 memoryUsage 自监控记录趋势，
// 并在堆持续超高水位时自动重启释放（治标，不改动任何功能逻辑）。

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const CHECK_MS = 30000 // 每 30 秒采样一次
const HIGH_MB = 1000 // heapUsed 超过 1000MB 视为高水位
const HIGH_TIMES = 3 // 连续 3 次（约 90 秒）才动手，避免误判瞬时峰值
const COOLDOWN_MS = 20 * 60 * 1000 // 两次自动重启至少间隔 20 分钟，防止重启循环
const KEEP_LINES = 400 // 日志保留最近 400 行

function createGuard(getUserDataDir) {
  const logFile = path.join(getUserDataDir(), 'heap-monitor.log')

  const log = (obj) => {
    try {
      let line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n'
      try {
        const prev = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
        if (prev.length > KEEP_LINES) line = prev.slice(-(KEEP_LINES - 1)).join('\n') + '\n' + line
        else if (prev.length) line = prev.join('\n') + '\n' + line
      } catch (e) {
        /* 首次写，文件不存在 */
      }
      fs.writeFileSync(logFile, line)
    } catch (e) {
      /* 日志失败绝不影响主流程 */
    }
  }

  let highCount = 0
  let lastRestart = 0

  const check = () => {
    const m = process.memoryUsage()
    const mb = (n) => Math.round(n / 1048576)
    const snap = {
      rss: mb(m.rss),
      heapUsed: mb(m.heapUsed),
      heapTotal: mb(m.heapTotal),
      external: mb(m.external),
      arrayBuffers: mb(m.arrayBuffers),
    }
    const high = snap.heapUsed >= HIGH_MB
    highCount = high ? highCount + 1 : 0
    log({ ...snap, high, highCount })

    const now = Date.now()
    if (highCount >= HIGH_TIMES && now - lastRestart >= COOLDOWN_MS) {
      lastRestart = now
      highCount = 0
      log({ ev: 'auto-restart', reason: 'heapUsed', heapUsed: snap.heapUsed })
      try { app.relaunch() } catch (e) {}
      try { app.exit(0) } catch (e) {}
    }
  }

  const start = () => {
    check()
    setInterval(check, CHECK_MS)
  }

  return { start, check, logFile }
}

module.exports = { createGuard }
