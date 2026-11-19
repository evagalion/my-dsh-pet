'use strict'

// 目标层专用 preload：只暴露 sg:* 渲染通道，跟桌宠主窗口的 petAPI 隔开。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('targetAPI', {
  // 输入屏障：把全屏拖拽事件（相对本窗口=workArea 原点）上报主进程
  barrierDown: (x, y) => ipcRenderer.send('sg:barrier-down', { x, y }),
  barrierMove: (x, y) => ipcRenderer.send('sg:barrier-move', { x, y }),
  barrierUp: (x, y) => ipcRenderer.send('sg:barrier-up', { x, y }),
  quit: () => ipcRenderer.send('sg:quit'),
  on: (channel, fn) => {
    const valid = ['sg:init', 'sg:hit', 'sg:clear', 'sg:bye', 'sg:aim', 'sg:aim-clear', 'sg:ammo', 'sg:move']
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, (_e, d) => fn(d))
  },
})
