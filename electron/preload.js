const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vroom', {
  sendTask: (text) => ipcRenderer.send('task', text),
  switchTab: (tabId, bounds) => ipcRenderer.send('switch-tab', tabId, bounds),
  updateBounds: (bounds) => ipcRenderer.send('update-bounds', bounds),
  onMessage: (callback) => ipcRenderer.on('message', (_, data) => callback(data)),
});
