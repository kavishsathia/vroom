const port = chrome.runtime.connect({ name: 'dashboard' });

const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const logEntries = document.getElementById('logEntries');

const tabs = {}; // tabId -> { card, img, label, status, stepInfo }

runBtn.addEventListener('click', () => {
  const text = taskInput.value.trim();
  if (!text) return;
  port.postMessage({ type: 'task', text });
  runBtn.disabled = true;
  log('Task: ' + text);
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runBtn.click();
  }
});

port.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    statusText.textContent = msg.message;

    // Parse executor spawn messages to create cards
    const spawnMatch = msg.message.match(/Spawned executor (exec_\d+): (.+)/);
    if (spawnMatch) {
      // Card will be created when we get tab_opened with executor info
    }

    // Parse tab-specific status
    const tabMatch = msg.message.match(/\[Tab (\d+)\] (.+)/);
    if (tabMatch) {
      const tabId = parseInt(tabMatch[1]);
      const detail = tabMatch[2];
      if (tabs[tabId]) {
        tabs[tabId].stepInfo.textContent = detail;
        if (detail.startsWith('Done:')) {
          tabs[tabId].statusEl.textContent = 'Done';
          tabs[tabId].statusEl.classList.add('done');
          tabs[tabId].card.classList.remove('active');
        }
      }
    }

    log(msg.message);

  } else if (msg.type === 'complete') {
    statusText.textContent = 'Complete';
    runBtn.disabled = false;
    log('Complete: ' + msg.summary, true);

  } else if (msg.type === 'tab_screenshot') {
    const tabId = msg.tabId;
    if (tabs[tabId]) {
      tabs[tabId].img.src = 'data:image/jpeg;base64,' + msg.data;
    }

  } else if (msg.type === 'tab_opened') {
    createTabCard(msg.tabId, msg.task || `Tab ${msg.tabId}`);

  } else if (msg.type === 'tab_closed') {
    removeTabCard(msg.tabId);

  } else if (msg.type === 'connected') {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
  }
});

function createTabCard(tabId, task) {
  if (tabs[tabId]) return;
  emptyState.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'tab-card active';

  const header = document.createElement('div');
  header.className = 'card-header';

  const label = document.createElement('div');
  label.className = 'tab-label';
  label.textContent = task;
  label.title = task;

  const statusEl = document.createElement('div');
  statusEl.className = 'tab-status';
  statusEl.textContent = 'Running';

  header.appendChild(label);
  header.appendChild(statusEl);

  const screenshotContainer = document.createElement('div');
  screenshotContainer.className = 'screenshot-container';

  const img = document.createElement('img');
  img.style.display = 'none';

  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'Waiting for screenshot...';

  img.addEventListener('load', () => {
    img.style.display = 'block';
    placeholder.style.display = 'none';
  });

  screenshotContainer.appendChild(img);
  screenshotContainer.appendChild(placeholder);

  const stepInfo = document.createElement('div');
  stepInfo.className = 'step-info';
  stepInfo.textContent = 'Starting...';

  card.appendChild(header);
  card.appendChild(screenshotContainer);
  card.appendChild(stepInfo);

  grid.appendChild(card);

  tabs[tabId] = { card, img, label, statusEl, stepInfo };
}

function removeTabCard(tabId) {
  if (!tabs[tabId]) return;
  tabs[tabId].card.remove();
  delete tabs[tabId];
  if (Object.keys(tabs).length === 0) {
    emptyState.style.display = '';
  }
}

function log(text, highlight = false) {
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (highlight ? ' highlight' : '');
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${text}`;
  logEntries.appendChild(entry);
  logEntries.scrollTop = logEntries.scrollHeight;
}
