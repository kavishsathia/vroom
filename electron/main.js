const { app, BrowserWindow, ipcMain, webContents, shell } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

app.name = 'Vroom';

let win = null;
let ws = null;
const tabs = {}; // tabId -> { webContents }
let nextTabId = 1;
const pendingTabRequests = {}; // requestId -> { tabIds, total, ready }

// --- Settings & Auth ---

const MANAGED_URL = 'wss://vroom-server-1015707621033.us-central1.run.app';
const MANAGED_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MANAGED_GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { mode: 'managed', serverUrl: '', auth: null };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getWsUrl() {
  const settings = loadSettings();
  const base = settings.mode === 'selfhosted' && settings.serverUrl
    ? settings.serverUrl
    : MANAGED_URL;
  const token = settings.auth?.idToken;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return null;
  }
}

async function refreshIdToken(refreshToken, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const tokens = JSON.parse(data);
          if (tokens.error) return reject(new Error(tokens.error_description || tokens.error));
          resolve(tokens.id_token);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function exchangeCode(code, port, codeVerifier, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const tokens = JSON.parse(data);
          if (tokens.error) return reject(new Error(tokens.error_description || tokens.error));
          const payload = decodeJwtPayload(tokens.id_token);
          resolve({
            idToken: tokens.id_token,
            refreshToken: tokens.refresh_token,
            email: payload?.email,
            name: payload?.name,
            picture: payload?.picture,
            sub: payload?.sub,
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function googleLogin(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const code = url.searchParams.get('code');
      if (!code) { res.writeHead(400); res.end('Missing code'); server.close(); reject(new Error('No code')); return; }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Login successful! You can close this tab.</h2></body></html>');
      server.close();

      try {
        const tokens = await exchangeCode(code, port, codeVerifier, clientId, clientSecret);
        resolve(tokens);
      } catch (err) { reject(err); }
    });

    let port;
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      shell.openExternal(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => { server.close(); reject(new Error('Login timed out')); }, 300000);
  });
}

// --- IPC: Settings & Auth ---

ipcMain.handle('get-settings', () => {
  const settings = loadSettings();
  return {
    mode: settings.mode,
    serverUrl: settings.serverUrl,
    auth: settings.auth ? {
      email: settings.auth.email,
      name: settings.auth.name,
      picture: settings.auth.picture,
    } : null,
  };
});

ipcMain.handle('save-settings', (_, { mode, serverUrl }) => {
  const settings = loadSettings();
  settings.mode = mode;
  settings.serverUrl = serverUrl;
  saveSettings(settings);
  // Reconnect with updated URL
  if (ws) ws.close();
  return { success: true };
});

ipcMain.handle('google-login', async () => {
  const settings = loadSettings();
  const clientId = MANAGED_GOOGLE_CLIENT_ID;
  const clientSecret = MANAGED_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { success: false, error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars are not set.' };
  }
  try {
    const result = await googleLogin(clientId, clientSecret);
    settings.auth = result;
    saveSettings(settings);
    if (ws) ws.close(); // Reconnect with new token
    return { success: true, auth: { email: result.email, name: result.name, picture: result.picture } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('logout', () => {
  const settings = loadSettings();
  settings.auth = null;
  saveSettings(settings);
  if (ws) ws.close();
  return { success: true };
});

// --- Window ---

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

// --- WebSocket ---

async function connectWebSocket() {
  // Refresh token if expired
  const settings = loadSettings();
  if (settings.auth?.idToken && settings.auth?.refreshToken && MANAGED_GOOGLE_CLIENT_ID && MANAGED_GOOGLE_CLIENT_SECRET) {
    const payload = decodeJwtPayload(settings.auth.idToken);
    if (payload && payload.exp * 1000 < Date.now() - 60000) {
      try {
        const newToken = await refreshIdToken(settings.auth.refreshToken, MANAGED_GOOGLE_CLIENT_ID, MANAGED_GOOGLE_CLIENT_SECRET);
        settings.auth.idToken = newToken;
        saveSettings(settings);
        console.log('[vroom] Refreshed ID token');
      } catch (err) {
        console.error('[vroom] Token refresh failed:', err.message);
      }
    }
  }

  const url = getWsUrl();
  console.log('[vroom] Connecting to', url.replace(/token=[^&]+/, 'token=***'));
  ws = new WebSocket(url);

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
              const x=${data.x}, y=${data.y};
              const el = document.elementFromPoint(x, y);
              if (!el) return;
              const opts = {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse'};
              el.dispatchEvent(new PointerEvent('pointerdown', opts));
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new PointerEvent('pointerup', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
              if (el.focus && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT'||el.isContentEditable||el.tabIndex>=0)) el.focus();
            })()`,
          });
        } else if (data.action === 'hover') {
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `(function(){
              const x=${data.x}, y=${data.y};
              const el = document.elementFromPoint(x, y);
              if (!el) return;
              const opts = {bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse'};
              el.dispatchEvent(new PointerEvent('pointermove', opts));
              el.dispatchEvent(new MouseEvent('mouseover', opts));
              el.dispatchEvent(new MouseEvent('mouseenter', {...opts, bubbles:false}));
              el.dispatchEvent(new MouseEvent('mousemove', opts));
            })()`,
          });
        } else if (data.action === 'type') {
          const escaped = data.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `(function(){
              const el = document.activeElement;
              if (el) document.execCommand('insertText', false, '${escaped}');
            })()`,
          });
        } else if (data.action === 'key_press') {
          const escaped = data.key.replace(/'/g, "\\'");
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `(function(){
              const el = document.activeElement;
              if (!el) return;
              const opts = {bubbles:true,cancelable:true,key:'${escaped}',ctrlKey:${!!data.ctrl},shiftKey:${!!data.shift},altKey:${!!data.alt},metaKey:${!!data.meta}};
              el.dispatchEvent(new KeyboardEvent('keydown', opts));
              el.dispatchEvent(new KeyboardEvent('keypress', opts));
              if ('${escaped}'==='Enter') {
                const form = el.closest && el.closest('form');
                if (form) form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
                else if (el.tagName==='TEXTAREA') document.execCommand('insertText',false,'\\n');
              }
              el.dispatchEvent(new KeyboardEvent('keyup', opts));
            })()`,
          });
        } else if (data.action === 'navigate') {
          await entry.webContents.loadURL(data.url);
          await new Promise(resolve => {
            entry.webContents.once('did-finish-load', resolve);
            setTimeout(resolve, 10000);
          });
        } else if (data.action === 'scroll') {
          const amount = data.amount || 400;
          const dx = data.direction === 'left' ? -amount : data.direction === 'right' ? amount : 0;
          const dy = data.direction === 'up' ? -amount : data.direction === 'down' ? amount : 0;
          await dbg.sendCommand('Runtime.evaluate', {
            expression: `window.scrollBy(${dx}, ${dy})`,
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

    } else if (data.type === 'audio_chunk' || data.type === 'audio' || data.type === 'speech_state' || data.type === 'status' || data.type === 'complete' || data.type === 'clear_audio' || data.type === 'preempt_transcript' || data.type === 'log' || data.type === 'contract_update') {
      toRenderer(data);
    }
  });

  ws.on('close', () => {
    console.log('[vroom] Disconnected, reconnecting...');
    toRenderer({ type: 'status', message: 'Disconnected, reconnecting...' });
    toRenderer({ type: 'disconnected' });
    setTimeout(connectWebSocket, 3000);
  });

  ws.on('error', (err) => {
    console.error('[vroom] WebSocket error:', err.message);
  });
}

// --- IPC: Webview & Tabs ---

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

ipcMain.on('task', (_, text, tabInfo, audioData) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { type: 'task', text };
    if (tabInfo && tabInfo.length > 0) msg.existingTabs = tabInfo;
    if (audioData) {
      msg.audio = audioData.data;
      msg.audioMimeType = audioData.mimeType;
    }
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

ipcMain.on('visual-preempt-start', (_, tabId, agentId) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'visual_preempt_start', tabId, agentId }));
  }
});

ipcMain.on('visual-preempt-end', (_, tabId, agentId, interactions) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'visual_preempt_end', tabId, agentId, interactions }));
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
