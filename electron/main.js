const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const path = require('path');
const WebSocket = require('ws');

app.name = 'Vroom';

let win = null;
let ws = null;
const tabs = {}; // tabId -> { webContents }
let nextTabId = 1;
const pendingTabRequests = {}; // requestId -> { tabIds, total, ready }

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Vroom',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  win.loadFile('index.html');

  win.on('enter-full-screen', () => {
    win.webContents.executeJavaScript('document.body.classList.add("fullscreen")');
  });
  win.on('leave-full-screen', () => {
    win.webContents.executeJavaScript('document.body.classList.remove("fullscreen")');
  });

  connectWebSocket();
}

function connectWebSocket() {
  ws = new WebSocket('ws://localhost:8765');

  ws.on('open', () => {
    console.log('[vroom] Connected to server');
    toRenderer({ type: 'connected' });
    toRenderer({ type: 'status', message: 'Connected to server' });
  });

  ws.on('message', async (raw) => {
    const data = JSON.parse(raw);
    const rid = data.requestId;

    if (data.type === 'screenshot_request') {
      const entry = tabs[data.tabId];
      if (!entry) {
        respond({ type: 'screenshot_response', data: '', requestId: rid });
        return;
      }
      try {
        const result = await entry.webContents.debugger.sendCommand(
          'Page.captureScreenshot',
          { format: 'jpeg', quality: 70 }
        );
        respond({ type: 'screenshot_response', data: result.data, requestId: rid });
        toRenderer({ type: 'tab_screenshot', tabId: data.tabId, data: result.data });
      } catch (e) {
        console.error('[vroom] Screenshot error:', e);
        respond({ type: 'screenshot_response', data: '', requestId: rid });
      }

    } else if (data.type === 'action') {
      const entry = tabs[data.tabId];
      if (!entry) {
        respond({ type: 'action_result', success: false, requestId: rid });
        return;
      }
      try {
        const dbg = entry.webContents.debugger;

        if (data.action === 'click') {
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `(function(){
              const el = document.elementFromPoint(${data.x}, ${data.y});
              if (el) {
                el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,clientX:${data.x},clientY:${data.y}}));
                el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,clientX:${data.x},clientY:${data.y}}));
                el.dispatchEvent(new MouseEvent('click', {bubbles:true,clientX:${data.x},clientY:${data.y}}));
                el.focus && el.focus();
              }
            })()`,
          });
        } else if (data.action === 'type') {
          const escaped = data.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `document.execCommand('insertText', false, '${escaped}')`,
          });
        } else if (data.action === 'navigate') {
          await entry.webContents.loadURL(data.url);
        } else if (data.action === 'scroll_down') {
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `window.scrollBy(0, 300)`,
          });
        } else if (data.action === 'scroll_up') {
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `window.scrollBy(0, -300)`,
          });
        }
        respond({ type: 'action_result', success: true, requestId: rid });
      } catch (e) {
        console.error('[vroom] Action error:', e);
        respond({ type: 'action_result', success: false, requestId: rid });
      }

    } else if (data.type === 'open_tabs') {
      const tabIds = [];
      for (let i = 0; i < data.count; i++) {
        tabIds.push(nextTabId++);
      }
      pendingTabRequests[rid] = { tabIds, total: data.count, ready: 0 };
      toRenderer({
        type: 'create_webviews',
        tabIds,
        url: data.url || 'about:blank',
        task: data.task || '',
        requestId: rid,
      });

    } else if (data.type === 'close_tabs') {
      if (data.tabIds) {
        for (const id of data.tabIds) {
          if (tabs[id]) {
            try {
              tabs[id].webContents.debugger.sendCommand('Page.stopScreencast').catch(() => {});
              tabs[id].webContents.debugger.detach();
            } catch (_) {}
            delete tabs[id];
            toRenderer({ type: 'tab_closed', tabId: id });
          }
        }
      }

    } else if (data.type === 'audio_chunk' || data.type === 'audio' || data.type === 'speech_state' || data.type === 'status' || data.type === 'complete' || data.type === 'clear_audio' || data.type === 'preempt_transcript' || data.type === 'log') {
      toRenderer(data);
    }
  });

  ws.on('close', () => {
    console.log('[vroom] Disconnected, reconnecting...');
    toRenderer({ type: 'status', message: 'Disconnected, reconnecting...' });
    setTimeout(connectWebSocket, 3000);
  });

  ws.on('error', (err) => {
    console.error('[vroom] WebSocket error:', err.message);
  });
}

ipcMain.on('webview-ready', async (_, tabId, webContentsId, requestId) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      console.error('[vroom] webContents not found for id:', webContentsId);
      return;
    }

    // Skip if already registered (e.g. dom-ready fires again on navigation)
    if (tabs[tabId]) return;

    wc.setBackgroundThrottling(false);
    try { wc.debugger.attach('1.3'); } catch (_) {}

    const currentTabId = tabId;
    wc.debugger.on('message', (_, method, params) => {
      if (method === 'Page.screencastFrame') {
        toRenderer({ type: 'tab_screenshot', tabId: currentTabId, data: params.data });
        wc.debugger.sendCommand('Page.screencastFrameAck', {
          sessionId: params.sessionId,
        }).catch(() => {});
      }
    });

    await wc.debugger.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: 40,
      maxWidth: 640,
      maxHeight: 400,
      everyNthFrame: 2,
    });

    tabs[tabId] = { webContents: wc };

    const pending = pendingTabRequests[requestId];
    if (pending) {
      pending.ready++;
      if (pending.ready >= pending.total) {
        respond({ type: 'tabs_opened', tabIds: pending.tabIds, requestId });
        delete pendingTabRequests[requestId];
      }
    }
  } catch (e) {
    console.error('[vroom] Error setting up webview:', e);
  }
});

function toRenderer(msg) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('message', msg);
  }
}

function respond(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

ipcMain.on('close-tabs', (_, tabIds) => {
  const serverTabIds = [];
  for (const id of tabIds) {
    if (tabs[id]) {
      try {
        tabs[id].webContents.debugger.sendCommand('Page.stopScreencast').catch(() => {});
        tabs[id].webContents.debugger.detach();
      } catch (_) {}
      delete tabs[id];
      serverTabIds.push(id);
    }
  }
  if (serverTabIds.length > 0) {
    respond({ type: 'close_tabs', tabIds: serverTabIds });
  }
});

ipcMain.handle('capture-tab', async (_, tabId) => {
  const entry = tabs[tabId];
  if (!entry) return '';
  try {
    const result = await entry.webContents.debugger.sendCommand(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 70 }
    );
    return result.data; // base64 string
  } catch (e) {
    console.error('[vroom] Capture error:', e);
    return '';
  }
});

ipcMain.on('task', (_, text, tabInfo) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { type: 'task', text };
    if (tabInfo && tabInfo.length > 0) msg.existingTabs = tabInfo;
    ws.send(JSON.stringify(msg));
  }
});

ipcMain.on('preempt-start', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'preempt_start' }));
  }
});

ipcMain.on('preempt-end', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'preempt_end' }));
  }
});

ipcMain.on('preempt-audio', (_, audioB64, mimeType) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'preempt_audio', data: audioB64, mimeType }));
  }
});

ipcMain.on('focus-renderer', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.focus();
  }
});

ipcMain.on('pause-agents', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'pause' }));
  }
});

ipcMain.on('resume-agents', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resume' }));
  }
});

ipcMain.on('user-log', (_, message) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'user_log', message }));
  }
});


app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'logo.png'));
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
