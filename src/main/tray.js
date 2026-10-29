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

  // 穿透开着时右键菜单唤不出来，托盘是唯一的后悔药，所以开关在这里也放一份。
  // 切换后要重建菜单，不然文案还停在旧状态上
  const build = () =>
    Menu.buildFromTemplate([
      { label: '摸一下', click: actions.poke },
      { label: '它在干嘛？', click: actions.speak },
      { type: 'separator' },
      { label: actions.clickThroughLabel(), click: () => actions.toggleClickThrough() },
      { label: '回到屏幕右下角', click: actions.reset },
      { type: 'separator' },
      { label: '打开 WorkBuddy', click: actions.openWorkBuddy },
      { label: '打开 Cursor', click: actions.openCursor },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])

  tray.setContextMenu(build())
  // 挂在实例上，主进程切换穿透后调它刷新文案
  tray.rebuild = () => tray.setContextMenu(build())
  return tray
}

module.exports = { createTray }
