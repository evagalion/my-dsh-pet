'use strict'

// 聊天窗口专用 preload。只暴露聊天相关通道，跟桌宠主窗口的 petAPI 互不干扰。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatAPI', {
  ready: () => ipcRenderer.send('chat:ready'),
  send: (text) => ipcRenderer.send('chat:send', text),
  close: () => ipcRenderer.send('chat:close'),
  clear: () => ipcRenderer.send('chat:clear'),
  on: (channel, fn) => {
    const valid = ['chat:init', 'chat:reply', 'chat:error']
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, (_e, d) => fn(d))
  },
})
