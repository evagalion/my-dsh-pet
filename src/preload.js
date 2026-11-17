'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  boot: () => ipcRenderer.invoke('pet:boot'),
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', dx, dy),
  throw: (vx, vy) => ipcRenderer.send('pet:throw', vx, vy),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  click: () => ipcRenderer.send('pet:click'),
  bond: (kind) => ipcRenderer.send('pet:bond', kind),
  openMenu: () => ipcRenderer.send('pet:menu'),
  walk: (dist, ms) => ipcRenderer.send('pet:walk', dist, ms),
  selftest: (data) => ipcRenderer.send('pet:selftest', data),
  debug: (data) => ipcRenderer.send('pet:debug', data),
  on: (channel, fn) => {
    const valid = [
      'pet:state',
      'pet:poke',
      'pet:feed',
      'pet:mood',
      'pet:liedown',
      'pet:stuck',
      'pet:routine',
      'pet:clickthrough',
      'pet:achieve',
      'pet:gift',
      'pet:digest',
      'pet:occasion',
      'pet:lonely',
      'pet:rps',
      'pet:note',
      'pet:landed',
      'pet:speak',
      'pet:chat',
      'pet:evolve',
      'pet:crawl',
      'pet:play',
      'pet:walk-done',
      'pet:reload-config',
    ]
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, (_e, payload) => fn(payload))
  },
})
