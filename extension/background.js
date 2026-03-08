let ws = null;
let sidepanelPort = null;
let micPort = null;
let frameInterval = null;
let targetWindowId = null;
let targetTabId = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidepanelPort = port;
    connectWebSocket();

    // Save the current tab/window as the target before anything else
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        targetTabId = tab.id;
        targetWindowId = tab.windowId;
        console.log('[Vroom] Target tab:', targetTabId, 'window:', targetWindowId);
        startFrameCapture();
      }
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'start_mic') {
        openMicPopup();
      } else if (msg.type === 'stop_mic') {
        if (micPort) micPort.postMessage({ type: 'stop_mic' });
      } else if (msg.type === 'task') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
    });

    port.onDisconnect.addListener(() => {
      sidepanelPort = null;
      stopFrameCapture();
      if (micPort) micPort.postMessage({ type: 'stop_mic' });
    });

  } else if (port.name === 'mic') {
    micPort = port;

    port.onMessage.addListener((msg) => {
      if (msg.type === 'audio_chunk') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'audio', data: msg.data }));
        }
      } else if (msg.type === 'mic_started') {
        console.log('[Vroom] Mic recording started');
        if (sidepanelPort) sidepanelPort.postMessage({ type: 'status', message: 'Mic recording' });
      } else if (msg.type === 'mic_error') {
        console.error('[Vroom] Mic error:', msg.error);
        if (sidepanelPort) sidepanelPort.postMessage({ type: 'status', message: 'Mic error: ' + msg.error });
      }
    });

    port.onDisconnect.addListener(() => {
      micPort = null;
      console.log('[Vroom] Mic popup closed');
    });
  }
});

function openMicPopup() {
  chrome.windows.create({
    url: 'mic.html',
    type: 'popup',
    width: 320,
    height: 120,
    focused: false,
  });
}

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket('ws://localhost:8765');

  ws.onopen = () => {
    console.log('[Vroom] Connected to server');
    if (sidepanelPort) sidepanelPort.postMessage({ type: 'status', message: 'Connected to server' });
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'action') {
      if (targetTabId) {
        if (data.action === 'click') {
          // Use Chrome DevTools Protocol for trusted click events
          performTrustedClick(targetTabId, data.x, data.y).then(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'action_result', success: true }));
            }
          });
        } else {
          chrome.tabs.sendMessage(targetTabId, data, (response) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'action_result', success: response?.success ?? false }));
            }
          });
        }
      }
    } else if (data.type === 'screenshot_request') {
      captureScreenshot().then((base64) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'screenshot_response', data: base64 }));
        }
      });
    } else if (data.type === 'status' || data.type === 'complete') {
      if (sidepanelPort) sidepanelPort.postMessage(data);
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

async function performTrustedClick(tabId, x, y) {
  // Attach debugger, send trusted mouse events via CDP, then detach
  await chrome.debugger.attach({ tabId }, '1.3');
  const params = { type: 'mousePressed', x, y, button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
  await chrome.debugger.detach({ tabId });
  console.log(`[Vroom] Trusted click at (${x}, ${y})`);
}

async function captureScreenshot() {
  // Always capture from the target window, not whatever is focused
  const dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'jpeg', quality: 70 });
  return dataUrl.split(',')[1];
}

function startFrameCapture() {
  stopFrameCapture();
  frameInterval = setInterval(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const base64 = await captureScreenshot();
        ws.send(JSON.stringify({ type: 'frame', data: base64 }));
      } catch (e) {
        // Tab might not be capturable
      }
    }
  }, 1000);
}

function stopFrameCapture() {
  if (frameInterval) {
    clearInterval(frameInterval);
    frameInterval = null;
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
