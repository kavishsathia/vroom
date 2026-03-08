let ws = null;
let sidepanelPort = null;
let dashboardPort = null;
const executorTabs = {}; // tabId -> task string

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
        const base64 = await captureTabScreenshot(data.tabId);
        respond({ type: 'screenshot_response', data: base64, requestId: rid });

        // Forward to dashboard for live view
        if (dashboardPort && data.tabId in executorTabs) {
          dashboardPort.postMessage({
            type: 'tab_screenshot',
            tabId: data.tabId,
            data: base64,
          });
        }
      } catch (e) {
        console.error('[Vroom] Screenshot error:', e);
        respond({ type: 'screenshot_response', data: '', requestId: rid });
      }

    } else if (data.type === 'action') {
      try {
        if (data.action === 'click') {
          await performTrustedClick(data.tabId, data.x, data.y);
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
          delete executorTabs[id];
          if (dashboardPort) {
            dashboardPort.postMessage({ type: 'tab_closed', tabId: id });
          }
        }
        await chrome.tabs.remove(data.tabIds);
      }

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

async function captureTabScreenshot(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Page.captureScreenshot',
    { format: 'jpeg', quality: 70 }
  );
  await chrome.debugger.detach({ tabId });
  return result.data;
}

async function performTrustedClick(tabId, x, y) {
  await chrome.debugger.attach({ tabId }, '1.3');
  const params = { type: 'mousePressed', x, y, button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
  await chrome.debugger.detach({ tabId });
  console.log(`[Vroom] Trusted click at (${x}, ${y}) on tab ${tabId}`);
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
