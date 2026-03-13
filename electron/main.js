const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const WebSocket = require('ws');

let win = null;
let ws = null;
const tabs = {}; // tabId -> { window: BrowserWindow }
let nextTabId = 1;
let activeTabId = null;

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

  // When main window moves or resizes, reposition the active child window
  const repositionActive = () => {
    if (activeTabId !== null && tabs[activeTabId]) {
      toRenderer({ type: 'request_bounds' });
    }
  };
  win.on('move', repositionActive);
  win.on('resize', repositionActive);

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
        const result = await entry.window.webContents.debugger.sendCommand(
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
        const dbg = entry.window.webContents.debugger;

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
          await entry.window.webContents.loadURL(data.url);
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
        const tabWin = new BrowserWindow({
          width: 1280,
          height: 800,
          show: false,
          parent: win,
          frame: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });

        tabWin.webContents.debugger.attach('1.3');

        // Listen for screencast frames
        const currentTabId = tabId;
        tabWin.webContents.debugger.on('message', (_, method, params) => {
          if (method === 'Page.screencastFrame') {
            toRenderer({ type: 'tab_screenshot', tabId: currentTabId, data: params.data });
            tabWin.webContents.debugger.sendCommand('Page.screencastFrameAck', {
              sessionId: params.sessionId,
            }).catch(() => {});
          }
        });

        await tabWin.webContents.loadURL(data.url || 'about:blank');

        // Start screencast
        await tabWin.webContents.debugger.sendCommand('Page.startScreencast', {
          format: 'jpeg',
          quality: 40,
          maxWidth: 640,
          maxHeight: 400,
          everyNthFrame: 2,
        });

        tabs[tabId] = { window: tabWin };
        tabIds.push(tabId);

        toRenderer({ type: 'tab_opened', tabId, task: data.task || '' });
      }
      respond({ type: 'tabs_opened', tabIds, requestId: rid });

    } else if (data.type === 'close_tabs') {
      if (data.tabIds) {
        for (const id of data.tabIds) {
          if (tabs[id]) {
            if (activeTabId === id) {
              activeTabId = null;
            }
            try {
              tabs[id].window.webContents.debugger.sendCommand('Page.stopScreencast').catch(() => {});
              tabs[id].window.webContents.debugger.detach();
            } catch (_) {}
            tabs[id].window.destroy();
            delete tabs[id];
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

// Switch tab: position child window over the content area
ipcMain.on('switch-tab', (_, tabId, bounds) => {
  // Hide previous
  if (activeTabId !== null && tabs[activeTabId] && !tabs[activeTabId].window.isDestroyed()) {
    tabs[activeTabId].window.hide();
  }

  if (tabId === null) {
    activeTabId = null;
    return;
  }

  const entry = tabs[tabId];
  if (!entry || entry.window.isDestroyed()) return;

  activeTabId = tabId;
  positionChildWindow(entry.window, bounds);
  entry.window.showInactive();
});

// Reposition on resize/move
ipcMain.on('update-bounds', (_, bounds) => {
  if (activeTabId !== null && tabs[activeTabId] && !tabs[activeTabId].window.isDestroyed()) {
    positionChildWindow(tabs[activeTabId].window, bounds);
  }
});

function positionChildWindow(childWin, bounds) {
  // bounds are relative to the renderer (CSS pixels relative to the window content)
  // Convert to screen coordinates
  const winBounds = win.getContentBounds();
  const x = Math.round(winBounds.x + bounds.x);
  const y = Math.round(winBounds.y + bounds.y);
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);

  childWin.setBounds({ x, y, width, height });
}

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
