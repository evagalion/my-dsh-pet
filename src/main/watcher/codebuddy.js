'use strict'

// CodeBuddy Code（CLI）状态来源：
//   ~/.codebuddy/projects/<项目目录>/<sessionId>.jsonl —— 每轮对话一个文件，边跑边追加。
//   取最新的 mtime 当活性信号，项目名和"在处理哪个问题"都从里面抠。

const path = require('node:path')
const os = require('node:os')
const { newestProject, cleanProjectName, readHead, decidePhase } = require('./transcript')
const { stepsOf, stepText } = require('./steps')

const PROJECTS = path.join(os.homedir(), '.codebuddy', 'projects')
const STEP_LIMIT = 12

// 同 Cursor：停了 + 最后一句是 assistant = 这轮跑完了，别再挂着"整理中"
const WORKING_MS = 20_000
const DONE_MS = 35_000
const COOLDOWN_MS = 50_000

function createCodeBuddyWatcher() {
  function poll() {
    const off = {
      source: 'codebuddy',
      online: false,
      phase: 'idle',
      project: '',
      detail: '',
      title: '',
      cwd: '',
    }
    const s = newestProject(PROJECTS, { depth: 0 })
    if (!s) return off

    const gap = Date.now() - s.mtime
    const h = readHead(s.file, s.mtime, s.size)

    const phase = decidePhase(gap, h, {
      working: WORKING_MS,
      done: DONE_MS,
      cooldown: COOLDOWN_MS,
    })
    const steps = stepsOf('codebuddy', s.file, { cwd: h.cwd, limit: STEP_LIMIT })
    return {
      source: 'codebuddy',
      online: gap < COOLDOWN_MS * 4,
      phase,
      project: cleanProjectName(s.project),
      cwd: h.cwd || '',
      title: h.title || '',
      detail: '',
      step: steps.length ? stepText(steps[0]) : '',
      steps,
    }
  }

  return { poll }
}

module.exports = { createCodeBuddyWatcher, PROJECTS }
