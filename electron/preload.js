const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vroom', {
  sendTask: (text, tabInfo, audioData) => ipcRenderer.send('task', text, tabInfo, audioData),
  captureTab: (tabId) => ipcRenderer.invoke('capture-tab', tabId),
  registerWebview: (tabId, webContentsId, requestId) => ipcRenderer.send('webview-ready', tabId, webContentsId, requestId),
  closeTabs: (tabIds) => ipcRenderer.send('close-tabs', tabIds),
  preemptStart: () => ipcRenderer.send('preempt-start'),
  preemptEnd: () => ipcRenderer.send('preempt-end'),
  preemptAudio: (audioB64, mimeType) => ipcRenderer.send('preempt-audio', audioB64, mimeType),
  sendLog: (message) => ipcRenderer.send('user-log', message),
  focusRenderer: () => ipcRenderer.send('focus-renderer'),
  pauseAgents: () => ipcRenderer.send('pause-agents'),
  resumeAgents: () => ipcRenderer.send('resume-agents'),
  visualPreemptStart: (tabId, agentId) => ipcRenderer.send('visual-preempt-start', tabId, agentId),
  visualPreemptEnd: (tabId, agentId, interactions) => ipcRenderer.send('visual-preempt-end', tabId, agentId, interactions),
  onMessage: (callback) => ipcRenderer.on('message', (_, data) => callback(data)),

  // Skills
  listSkills: () => ipcRenderer.send('list-skills'),
  saveSkill: (name, description, text) => ipcRenderer.send('save-skill', name, description, text),
  deleteSkill: (name) => ipcRenderer.send('delete-skill', name),

  // Settings & Auth
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  googleLogin: () => ipcRenderer.invoke('google-login'),
  logout: () => ipcRenderer.invoke('logout'),
});
