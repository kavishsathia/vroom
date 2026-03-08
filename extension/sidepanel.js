const port = chrome.runtime.connect({ name: 'sidepanel' });
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('send');
const taskEl = document.getElementById('task');

sendBtn.addEventListener('click', () => {
  const text = taskEl.value.trim();
  if (!text) return;
  port.postMessage({ type: 'task', text });
  statusEl.textContent = 'Running...';
  log('Task: ' + text);
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
