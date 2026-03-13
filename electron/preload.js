const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vroom', {
  sendTask: (text) => ipcRenderer.send('task', text),
  onMessage: (callback) => ipcRenderer.on('message', (_, data) => callback(data)),
});
