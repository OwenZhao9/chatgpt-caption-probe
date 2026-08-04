const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('probe', {
  dump: () => ipcRenderer.send('bar:dump'),
  reset: () => ipcRenderer.send('bar:reset'),
  toggleCaptions: () => ipcRenderer.send('bar:toggle-captions'),
  onHealth: (fn) => ipcRenderer.on('bar:health', (_e, h) => fn(h)),
})
