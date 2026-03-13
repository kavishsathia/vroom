const tabList = document.getElementById('tabList');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const logEntries = document.getElementById('logEntries');

const logToggle = document.getElementById('logToggle');
const logPanel = document.getElementById('logPanel');

logToggle.addEventListener('click', () => {
  logPanel.classList.toggle('open');
});

const tabs = {};
const agentTabs = {};
let nextAgentId = null;
let activeTabId = null;

runBtn.addEventListener('click', () => {
  const text = taskInput.value.trim();
  if (!text) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  window.vroom.sendTask(text);
  runBtn.disabled = true;
  log('Task: ' + text);
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runBtn.click();
  }
});

taskInput.addEventListener('input', () => {
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 160) + 'px';
});

function getGridBounds() {
  const rect = grid.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// Reposition child window on resize
window.addEventListener('resize', () => {
  if (activeTabId !== null) {
    window.vroom.updateBounds(getGridBounds());
  }
});

function switchToTab(tabId) {
  activeTabId = tabId;
  for (const id in tabs) {
    tabs[id].card.style.display = 'none';
    tabs[id].sidebarTab.classList.toggle('focused', parseInt(id) === tabId);
  }
  emptyState.style.display = 'none';

  requestAnimationFrame(() => {
    window.vroom.switchTab(tabId, getGridBounds());
  });
}

function switchToGrid() {
  activeTabId = null;
  for (const id in tabs) {
    tabs[id].card.style.display = '';
    tabs[id].sidebarTab.classList.remove('focused');
  }
  window.vroom.switchTab(null, { x: 0, y: 0, width: 0, height: 0 });
}

window.vroom.onMessage((msg) => {
  if (msg.type === 'status') {
    statusText.textContent = msg.message;

    const spawnMatch = msg.message.match(/Spawned executor (exec_\d+): (.+)/);
    if (spawnMatch) {
      nextAgentId = spawnMatch[1];
    }

    const tabMatch = msg.message.match(/\[Tab (\d+)\] (.+)/);
    if (tabMatch) {
      const tabId = parseInt(tabMatch[1]);
      const detail = tabMatch[2];
      if (tabs[tabId]) {
        tabs[tabId].stepInfo.textContent = detail;
        tabs[tabId].sidebarStep.textContent = detail;
        if (detail.startsWith('Done:')) {
          tabs[tabId].statusEl.textContent = 'Done';
          tabs[tabId].statusEl.classList.add('done');
          tabs[tabId].card.classList.remove('active');
          if (tabs[tabId].sidebarDot) {
            tabs[tabId].sidebarDot.className = 'tab-dot done';
          }
          if (tabs[tabId].sidebarBadge) {
            tabs[tabId].sidebarBadge.textContent = 'Done';
            tabs[tabId].sidebarBadge.classList.add('done');
          }
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
    if (nextAgentId) {
      agentTabs[nextAgentId] = msg.tabId;
      nextAgentId = null;
    }

  } else if (msg.type === 'tab_closed') {
    removeTabCard(msg.tabId);

  } else if (msg.type === 'speech_state') {
    const tabId = agentTabs[msg.agentId];
    if (tabId && tabs[tabId]) {
      if (tabs[tabId].speechIndicator) {
        const el = tabs[tabId].speechIndicator;
        el.className = 'speech-indicator';
        if (msg.state === 'queued') {
          el.classList.add('queued');
          el.textContent = 'Wants to speak';
        } else if (msg.state === 'spotlight') {
          el.classList.add('spotlight');
          el.textContent = 'Speaking';
        }
      }
      if (tabs[tabId].sidebarDot) {
        if (msg.state === 'spotlight') {
          tabs[tabId].sidebarDot.className = 'tab-dot speaking';
        } else {
          tabs[tabId].sidebarDot.className = 'tab-dot running';
        }
      }
    }

  } else if (msg.type === 'audio') {
    playAudio(msg.data, msg.agentId);

  } else if (msg.type === 'connected') {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';

  } else if (msg.type === 'request_bounds') {
    if (activeTabId !== null) {
      window.vroom.updateBounds(getGridBounds());
    }
  }
});

function createTabCard(tabId, task) {
  if (tabs[tabId]) return;
  emptyState.style.display = 'none';

  // Sidebar tab
  const sidebarTab = document.createElement('button');
  sidebarTab.className = 'sidebar-tab';

  const sidebarDot = document.createElement('div');
  sidebarDot.className = 'tab-dot running';

  const tabInfo = document.createElement('div');
  tabInfo.className = 'tab-info';

  const sidebarTitle = document.createElement('span');
  sidebarTitle.className = 'tab-title';
  const shortLabel = task.length > 40 ? task.substring(0, 40) + '...' : task;
  sidebarTitle.textContent = shortLabel;
  sidebarTitle.title = task;

  const sidebarStep = document.createElement('span');
  sidebarStep.className = 'tab-step';
  sidebarStep.textContent = 'Starting...';

  tabInfo.appendChild(sidebarTitle);
  tabInfo.appendChild(sidebarStep);

  const sidebarBadge = document.createElement('span');
  sidebarBadge.className = 'tab-badge';
  sidebarBadge.textContent = 'Running';

  sidebarTab.appendChild(sidebarDot);
  sidebarTab.appendChild(tabInfo);
  sidebarTab.appendChild(sidebarBadge);

  sidebarTab.addEventListener('click', () => {
    if (activeTabId === tabId) {
      switchToGrid();
    } else {
      switchToTab(tabId);
    }
  });

  tabList.appendChild(sidebarTab);

  // Grid card
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

  const speechIndicator = document.createElement('div');
  speechIndicator.className = 'speech-indicator';

  header.appendChild(label);
  header.appendChild(speechIndicator);
  header.appendChild(statusEl);

  const screenshotContainer = document.createElement('div');
  screenshotContainer.className = 'screenshot-container';

  const img = document.createElement('img');
  img.style.display = 'none';

  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'Waiting for stream...';

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

  tabs[tabId] = {
    card, img, label, statusEl, stepInfo, speechIndicator,
    sidebarTab, sidebarDot, sidebarStep, sidebarBadge,
  };
}

function removeTabCard(tabId) {
  if (!tabs[tabId]) return;
  if (activeTabId === tabId) switchToGrid();
  tabs[tabId].card.remove();
  tabs[tabId].sidebarTab.remove();
  delete tabs[tabId];
  if (Object.keys(tabs).length === 0) {
    emptyState.style.display = '';
  }
}

const audioCtx = new AudioContext();

async function playAudio(b64Data, agentId) {
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const raw = atob(b64Data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  const buffer = audioCtx.createBuffer(1, samples.length, 24000);
  buffer.getChannelData(0).set(samples);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();

  log(`[${agentId}] Speaking...`);
}

function log(text, highlight = false) {
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (highlight ? ' highlight' : '');
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${text}`;
  logEntries.appendChild(entry);
  logEntries.scrollTop = logEntries.scrollHeight;
}
