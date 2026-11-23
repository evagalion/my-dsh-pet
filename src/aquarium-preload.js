'use strict'

// 水族馆专用 preload。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aquariumAPI', {
  boot: () => ipcRenderer.invoke('aq:boot'),
  feed: () => ipcRenderer.invoke('aq:feed'),
  unlock: (id) => ipcRenderer.invoke('aq:unlock', id),
  upgrade: () => ipcRenderer.invoke('aq:upgrade'),
  close: () => ipcRenderer.send('aq:close'),
  on: (channel, fn) => {
    const valid = ['aq:snapshot']
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, (_e, d) => fn(d))
  },
})
