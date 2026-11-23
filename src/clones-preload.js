'use strict'

// 分身层专用 preload。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cloneAPI', {
  split: (id, x, y) => ipcRenderer.send('clone:split', { id, x, y }),
  // 抓鱼命中：golden=是否金色特殊鱼（主进程据此播放不同音效）
  caught: (golden) => ipcRenderer.send('clone:caught', !!golden),
  // 一局结束：主进程可在此记录最高分/播胜利音效
  over: (score, caught, maxCombo, win) => ipcRenderer.send('clone:over', { score, caught, maxCombo, win }),
  quit: () => ipcRenderer.send('clone:quit'),
  // 鼠标是否悬停在分身上：通知主进程动态切换窗口穿透，做到"能点鱼、又不妨碍点别的"
  hover: (on) => ipcRenderer.send('clone:hover', !!on),
  boot: () => ipcRenderer.invoke('clone:boot'),
  on: (channel, fn) => {
    const valid = ['clone:init', 'clone:bye']
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, (_e, d) => fn(d))
  },
})
