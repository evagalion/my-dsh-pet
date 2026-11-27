'use strict'

// 主进程内存自监控 + 保守自动回收。
//
// 背景（2026-11-27）：
//  - 11-27 上午：主进程 footprint 从 78MB 跳到 1.4G，当时误判为 tag16=JS 堆。
//  - 11-27 下午：飙到 15G。heap-monitor 证实真凶是 external（原生层内存）从 4MB
//    在 10 分钟内爬到 12G，而 heapUsed 一直只有 34MB。footprint 分解 tag16=12G、
//    tag14=2.3G、untagged=1.3G，与 external 吻合——tag16 其实是 external，不是 JS 堆。
//  上午版本只判 heapUsed，导致 external 暴涨完全没被拦住（auto-restart 0 次）。
//  这版改为 heapUsed / external 任一超高水位就重启，external 阈值更低。

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const CHECK_MS = 15000 // 每 15 秒采样，更早拦住爬升
const HEAP_HIGH_MB = 1000 // V8 JS 堆高水位
const EXT_HIGH_MB = 800 // external 原生内存高水位（下午就是它涨到 12G）
const HIGH_TIMES = 3 // 连续 3 次（约 45 秒）才动手，避免误判瞬时峰值
const COOLDOWN_MS = 20 * 60 * 1000 // 两次自动重启至少间隔 20 分钟，防止重启循环
const KEEP_LINES = 400

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
  let highReason = ''
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
    // 任一维度超阈值就算高水位，并记下是哪个维度
    let reason = ''
    if (snap.external >= EXT_HIGH_MB) reason = 'external'
    else if (snap.heapUsed >= HEAP_HIGH_MB) reason = 'heapUsed'

    if (reason && reason === highReason) highCount++
    else {
      highCount = reason ? 1 : 0
      highReason = reason
    }
    log({ ...snap, high: !!reason, highCount, reason })

    const now = Date.now()
    if (highCount >= HIGH_TIMES && now - lastRestart >= COOLDOWN_MS) {
      lastRestart = now
      highCount = 0
      highReason = ''
      log({ ev: 'auto-restart', reason, external: snap.external, heapUsed: snap.heapUsed })
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
