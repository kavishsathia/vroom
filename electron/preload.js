const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vroom', {
  sendTask: (text) => ipcRenderer.send('task', text),
  focusTab: (tabId, bounds) => ipcRenderer.send('focus-tab', tabId, bounds),
  unfocusTab: () => ipcRenderer.send('unfocus-tab'),
  onMessage: (callback) => ipcRenderer.on('message', (_, data) => callback(data)),
});
