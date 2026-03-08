const port = chrome.runtime.connect({ name: 'sidepanel' });
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('send');
const micBtn = document.getElementById('mic');
const taskEl = document.getElementById('task');

let micActive = false;

// Send text task
sendBtn.addEventListener('click', () => {
  const text = taskEl.value.trim();
  if (!text) return;
  port.postMessage({ type: 'task', text });
  statusEl.textContent = 'Running...';
  log('Task: ' + text);
});

// Toggle mic via offscreen document
micBtn.addEventListener('click', () => {
  if (micActive) {
    port.postMessage({ type: 'stop_mic' });
    micBtn.textContent = 'Start Mic';
    micBtn.classList.remove('active');
    micActive = false;
    log('Mic stopped');
  } else {
    port.postMessage({ type: 'start_mic' });
    micBtn.textContent = 'Stop Mic';
    micBtn.classList.add('active');
    micActive = true;
    log('Mic started - speak your task');
  }
});

port.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    statusEl.textContent = msg.message;
    log(msg.message);
  } else if (msg.type === 'complete') {
    statusEl.textContent = 'Done';
    log('Done: ' + msg.summary);
  }
});

function log(text) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}
