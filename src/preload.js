'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  boot: () => ipcRenderer.invoke('pet:boot'),
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', dx, dy),
  throw: (vx, vy) => ipcRenderer.send('pet:throw', vx, vy),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  click: () => ipcRenderer.send('pet:click'),
  openMenu: () => ipcRenderer.send('pet:menu'),
  hover: (inside) => ipcRenderer.send('pet:hover', inside),
  walk: (dist, ms) => ipcRenderer.send('pet:walk', dist, ms),
  selftest: (data) => ipcRenderer.send('pet:selftest', data),
  debug: (data) => ipcRenderer.send('pet:debug', data),
  on: (channel, fn) => {
    const valid = [
      'pet:state',
      'pet:poke',
      'pet:landed',
      'pet:speak',
      'pet:play',
      'pet:walk-done',
      'pet:reload-config',
    ]
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, (_e, payload) => fn(payload))
  },
})
