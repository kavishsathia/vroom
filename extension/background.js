let ws = null;
let sidepanelPort = null;
let dashboardPort = null;
const executorTabs = {}; // tabId -> task string
const debuggerTabs = new Set(); // tabs with debugger attached

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidepanelPort = port;
    connectWebSocket();

    port.onMessage.addListener((msg) => {
      if (msg.type === 'task') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
    });

    port.onDisconnect.addListener(() => {
      sidepanelPort = null;
    });

  } else if (port.name === 'dashboard') {
    dashboardPort = port;
    connectWebSocket();

    port.onMessage.addListener((msg) => {
      if (msg.type === 'task') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
    });

    port.onDisconnect.addListener(() => {
      dashboardPort = null;
    });

    // Let dashboard know if already connected
    if (ws && ws.readyState === WebSocket.OPEN) {
      dashboardPort.postMessage({ type: 'connected' });
    }
  }
});

async function ensureDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerTabs.add(tabId);
    console.log(`[Vroom] Debugger attached to tab ${tabId}`);
  }
}

async function detachDebugger(tabId) {
  if (debuggerTabs.has(tabId)) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      // Tab may already be closed
    }
    debuggerTabs.delete(tabId);
    console.log(`[Vroom] Debugger detached from tab ${tabId}`);
  }
}

// Clean up if a tab with debugger is closed externally
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerTabs.delete(tabId);
});

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket('ws://localhost:8765');

  ws.onopen = () => {
    console.log('[Vroom] Connected to server');
    broadcast({ type: 'status', message: 'Connected to server' });
    if (dashboardPort) dashboardPort.postMessage({ type: 'connected' });
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    const rid = data.requestId;

    if (data.type === 'get_tab_info') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      respond({ type: 'tab_info', tabId: tab.id, url: tab.url, requestId: rid });

    } else if (data.type === 'screenshot_request') {
      try {
        await ensureDebugger(data.tabId);
        const result = await chrome.debugger.sendCommand(
          { tabId: data.tabId },
          'Page.captureScreenshot',
          { format: 'jpeg', quality: 70 }
        );
        respond({ type: 'screenshot_response', data: result.data, requestId: rid });

        // Forward to dashboard for live view
        if (dashboardPort && data.tabId in executorTabs) {
          dashboardPort.postMessage({
            type: 'tab_screenshot',
            tabId: data.tabId,
            data: result.data,
          });
        }
      } catch (e) {
        console.error('[Vroom] Screenshot error:', e);
        respond({ type: 'screenshot_response', data: '', requestId: rid });
      }

    } else if (data.type === 'action') {
      try {
        if (data.action === 'click') {
          await ensureDebugger(data.tabId);
          const params = { type: 'mousePressed', x: data.x, y: data.y, button: 'left', clickCount: 1 };
          await chrome.debugger.sendCommand({ tabId: data.tabId }, 'Input.dispatchMouseEvent', params);
          await chrome.debugger.sendCommand({ tabId: data.tabId }, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
          console.log(`[Vroom] Trusted click at (${data.x}, ${data.y}) on tab ${data.tabId}`);
        } else if (data.action === 'type') {
          await ensureDebugger(data.tabId);
          for (const char of data.text) {
            await chrome.debugger.sendCommand({ tabId: data.tabId }, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: char,
              key: char,
              unmodifiedText: char,
            });
            await chrome.debugger.sendCommand({ tabId: data.tabId }, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: char,
            });
          }
          console.log(`[Vroom] Trusted type "${data.text}" on tab ${data.tabId}`);
        } else if (data.action === 'navigate') {
          await chrome.tabs.update(data.tabId, { url: data.url });
          await waitForTabLoad(data.tabId);
        } else {
          await new Promise((resolve) => {
            chrome.tabs.sendMessage(data.tabId, data, resolve);
          });
        }
        respond({ type: 'action_result', success: true, requestId: rid });
      } catch (e) {
        console.error('[Vroom] Action error:', e);
        respond({ type: 'action_result', success: false, requestId: rid });
      }

    } else if (data.type === 'open_tabs') {
      const tabIds = [];
      for (let i = 0; i < data.count; i++) {
        const tab = await chrome.tabs.create({ url: data.url, active: false });
        tabIds.push(tab.id);
      }
      await Promise.all(tabIds.map((id) => waitForTabLoad(id)));

      // Attach debugger early so the banner is stable before first screenshot
      for (const id of tabIds) {
        await ensureDebugger(id);
      }

      // Track executor tabs with their task
      for (const id of tabIds) {
        executorTabs[id] = data.task || '';
      }

      respond({ type: 'tabs_opened', tabIds, requestId: rid });

      // Notify dashboard
      if (dashboardPort) {
        for (const id of tabIds) {
          dashboardPort.postMessage({
            type: 'tab_opened',
            tabId: id,
            task: data.task || '',
          });
        }
      }

    } else if (data.type === 'close_tabs') {
      if (data.tabIds && data.tabIds.length > 0) {
        for (const id of data.tabIds) {
          await detachDebugger(id);
          delete executorTabs[id];
          if (dashboardPort) {
            dashboardPort.postMessage({ type: 'tab_closed', tabId: id });
          }
        }
        await chrome.tabs.remove(data.tabIds);
      }

    } else if (data.type === 'audio' || data.type === 'speech_state') {
      broadcast(data);

    } else if (data.type === 'status' || data.type === 'complete') {
      broadcast(data);
    }
  };

  ws.onclose = () => {
    console.log('[Vroom] Disconnected, reconnecting...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('[Vroom] WebSocket error:', err);
  };
}

function broadcast(msg) {
  if (sidepanelPort) sidepanelPort.postMessage(msg);
  if (dashboardPort) dashboardPort.postMessage(msg);
}

function respond(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
