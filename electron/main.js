const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');

let win = null;
let ws = null;
const views = {}; // tabId -> BrowserView
let nextTabId = 1;
let focusedTabId = null;

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
    },
  });

  win.loadFile('index.html');
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
      const view = views[data.tabId];
      if (!view) {
        respond({ type: 'screenshot_response', data: '', requestId: rid });
        return;
      }
      try {
        const result = await view.webContents.debugger.sendCommand(
          'Page.captureScreenshot',
          { format: 'jpeg', quality: 70 }
        );
        respond({ type: 'screenshot_response', data: result.data, requestId: rid });
      } catch (e) {
        console.error('[vroom] Screenshot error:', e);
        respond({ type: 'screenshot_response', data: '', requestId: rid });
      }

    } else if (data.type === 'action') {
      const view = views[data.tabId];
      if (!view) {
        respond({ type: 'action_result', success: false, requestId: rid });
        return;
      }
      try {
        const dbg = view.webContents.debugger;

        if (data.action === 'click') {
          await dbg.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: data.x, y: data.y, button: 'left', clickCount: 1,
          });
          await dbg.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: data.x, y: data.y, button: 'left', clickCount: 1,
          });
        } else if (data.action === 'type') {
          for (const char of data.text) {
            await dbg.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyDown', text: char, key: char, unmodifiedText: char,
            });
            await dbg.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyUp', key: char,
            });
          }
        } else if (data.action === 'navigate') {
          await view.webContents.loadURL(data.url);
        } else if (data.action === 'scroll_down') {
          await dbg.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 300,
          });
        } else if (data.action === 'scroll_up') {
          await dbg.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: -300,
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
        const tabId = nextTabId++;
        const view = new BrowserView({
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        win.addBrowserView(view);
        // Park offscreen — screencast provides thumbnails
        view.setBounds({ x: -9999, y: 0, width: 1280, height: 800 });
        view.setAutoResize({ width: false, height: false });

        // Attach debugger persistently
        view.webContents.debugger.attach('1.3');

        await view.webContents.loadURL(data.url || 'about:blank');

        // Start screencast for thumbnails
        view.webContents.debugger.on('message', (_, method, params) => {
          if (method === 'Page.screencastFrame') {
            toRenderer({ type: 'tab_screenshot', tabId, data: params.data });
            view.webContents.debugger.sendCommand('Page.screencastFrameAck', {
              sessionId: params.sessionId,
            }).catch(() => {});
          }
        });
        await view.webContents.debugger.sendCommand('Page.startScreencast', {
          format: 'jpeg',
          quality: 40,
          maxWidth: 640,
          maxHeight: 400,
          everyNthFrame: 2,
        });

        views[tabId] = view;
        tabIds.push(tabId);

        toRenderer({ type: 'tab_opened', tabId, task: data.task || '' });
      }
      respond({ type: 'tabs_opened', tabIds, requestId: rid });

    } else if (data.type === 'close_tabs') {
      if (data.tabIds) {
        for (const id of data.tabIds) {
          if (views[id]) {
            if (focusedTabId === id) focusedTabId = null;
            win.removeBrowserView(views[id]);
            try { views[id].webContents.debugger.detach(); } catch (_) {}
            views[id].webContents.destroy();
            delete views[id];
            toRenderer({ type: 'tab_closed', tabId: id });
          }
        }
      }

    } else if (data.type === 'audio' || data.type === 'speech_state' || data.type === 'status' || data.type === 'complete') {
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

// Focus a tab: position its BrowserView over the grid area
ipcMain.on('focus-tab', (_, tabId, bounds) => {
  // Park the previously focused view offscreen
  if (focusedTabId !== null && views[focusedTabId]) {
    views[focusedTabId].setBounds({ x: -9999, y: 0, width: 1280, height: 800 });
  }

  focusedTabId = tabId;
  const view = views[tabId];
  if (!view) return;

  // Bring to top by re-adding
  win.removeBrowserView(view);
  win.addBrowserView(view);

  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
});

// Unfocus: park the view offscreen
ipcMain.on('unfocus-tab', () => {
  if (focusedTabId !== null && views[focusedTabId]) {
    views[focusedTabId].setBounds({ x: -9999, y: 0, width: 1280, height: 800 });
  }
  focusedTabId = null;
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

ipcMain.on('task', (_, text) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'task', text }));
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
