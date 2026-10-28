'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const DEFAULTS = require('../shared/pet.config.json')
const { ASSETS_DIR } = require('./paths')

function userConfigPath() {
  return path.join(app.getPath('userData'), 'pet.config.json')
}

// 用户配置只存"会变的东西"：窗口位置、穿透开关。
// 尺寸、动画映射等一律以 src/shared/pet.config.json 为准 —— 否则改了默认值，
// 旧的 user config 会把它盖回去（这个坑真踩过：窗口一直是 240x240）。
function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS))
  try {
    const raw = JSON.parse(fs.readFileSync(userConfigPath(), 'utf8'))
    if (raw.position && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)) {
      cfg.position = raw.position
    }
    if (typeof raw.clickThrough === 'boolean') cfg.pet.clickThrough = raw.clickThrough
    if (raw.sound && typeof raw.sound.enabled === 'boolean') cfg.sound.enabled = raw.sound.enabled
    if (raw.sound && (raw.sound.mode === 'voice' || raw.sound.mode === 'tone')) {
      cfg.sound.mode = raw.sound.mode
    }
  } catch {
    /* 第一次跑，用默认值 */
  }
  return cfg
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true })
    const slim = {
      position: cfg.position || null,
      clickThrough: !!cfg.pet.clickThrough,
      sound: {
        enabled: !!(cfg.sound && cfg.sound.enabled !== false),
        mode: (cfg.sound && cfg.sound.mode) === 'tone' ? 'tone' : 'voice',
      },
    }
    fs.writeFileSync(userConfigPath(), JSON.stringify(slim, null, 2), 'utf8')
  } catch (e) {
    console.error('[pet] 保存配置失败', e.message)
  }
}

function listAssets() {
  try {
    return fs
      .readdirSync(path.join(ASSETS_DIR, 'webm'))
      .filter((f) => f.endsWith('.webm'))
      .map((f) => f.replace(/\.webm$/, ''))
  } catch (e) {
    console.error('[pet] 读取素材失败', e.message)
    return []
  }
}

module.exports = { loadConfig, saveConfig, listAssets, userConfigPath, ASSETS_DIR }
