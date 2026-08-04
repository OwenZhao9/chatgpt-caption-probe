const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('captions', {
  onUpdate: (fn) => ipcRenderer.on('caption:update', (_e, payload) => fn(payload)),
  onClear: (fn) => ipcRenderer.on('caption:clear', () => fn()),
})
