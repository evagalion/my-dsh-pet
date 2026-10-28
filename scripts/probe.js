'use strict'

// 不启动界面，只验证探测层：连续采样 N 次，打印聚合后的状态。
// 用法：node scripts/probe.js [次数] [间隔毫秒]

const path = require('node:path')
const DEFAULTS = require('../src/shared/pet.config.json')
const { createWatcher } = require('../src/main/watcher')

const times = Number(process.argv[2] || 1)
const gap = Number(process.argv[3] || 3000)

;(async () => {
  const watcher = createWatcher(DEFAULTS)
  for (let i = 0; i < times; i++) {
    const s = await watcher.poll()
    const raw = await watcher.pollAll()
    console.log(`#${i + 1} 聚合: ${JSON.stringify(s)}`)
    for (const r of raw) {
      const ag = (DEFAULTS.agents && DEFAULTS.agents[r.source]) || {}
      console.log(
        `    ${(ag.label || r.source).padEnd(10)} ${String(r.phase).padEnd(10)} ` +
          `项目=${r.project || '-'}  问题=${r.title || '-'}  文件=${r.detail || '-'}`
      )
    }
    if (i < times - 1) await new Promise((r) => setTimeout(r, gap))
  }
})()
