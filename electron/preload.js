const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vroom', {
  sendTask: (text) => ipcRenderer.send('task', text),
  registerWebview: (tabId, webContentsId, requestId) => ipcRenderer.send('webview-ready', tabId, webContentsId, requestId),
  closeTabs: (tabIds) => ipcRenderer.send('close-tabs', tabIds),
  onMessage: (callback) => ipcRenderer.on('message', (_, data) => callback(data)),
});
