'use strict'

const { Tray, Menu, nativeImage, app } = require('electron')
const path = require('node:path')
const { ASSETS_DIR } = require('./paths')

function createTray(actions) {
  let icon
  try {
    icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'))
    if (icon.isEmpty()) icon = null
  } catch {
    icon = null
  }
  if (!icon) return null

  const tray = new Tray(icon.resize({ width: 18, height: 18 }))
  tray.setToolTip('大肥鱼桌宠')

  const menu = Menu.buildFromTemplate([
    { label: '摸一下', click: actions.poke },
    { label: '它在干嘛？', click: actions.speak },
    { type: 'separator' },
    { label: '回到屏幕右下角', click: actions.reset },
    { label: '打开 WorkBuddy', click: actions.openWorkBuddy },
    { label: '打开 Cursor', click: actions.openCursor },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  return tray
}

module.exports = { createTray }
