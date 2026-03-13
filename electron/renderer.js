const tabList = document.getElementById('tabList');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const logEntries = document.getElementById('logEntries');
const webviewLayer = document.getElementById('webviewLayer');

const urlBar = document.getElementById('urlBar');
const logToggle = document.getElementById('logToggle');
const logPanel = document.getElementById('logPanel');
const navBack = document.getElementById('navBack');
const navForward = document.getElementById('navForward');
const navRefresh = document.getElementById('navRefresh');
const themeToggle = document.getElementById('themeToggle');

const sidebarResizeHandle = document.getElementById('sidebarResizeHandle');
const logResizeHandle = document.getElementById('logResizeHandle');
const sidebar = document.querySelector('.sidebar');

const attachedTabs = document.getElementById('attachedTabs');
const attachedTabIds = []; // tab IDs dragged into the prompt

// --- Drag & drop tabs into prompt ---
taskInput.addEventListener('dragover', (e) => {
  e.preventDefault();
  taskInput.classList.add('drag-over');
});
taskInput.addEventListener('dragleave', () => {
  taskInput.classList.remove('drag-over');
});
taskInput.addEventListener('drop', (e) => {
  e.preventDefault();
  taskInput.classList.remove('drag-over');
  const tabId = parseInt(e.dataTransfer.getData('text/tab-id'));
  if (!tabId || isNaN(tabId)) return;
  if (attachedTabIds.includes(tabId)) return;
  attachedTabIds.push(tabId);
  renderAttachedTabs();
});

function renderAttachedTabs() {
  attachedTabs.innerHTML = '';
  for (const tabId of attachedTabIds) {
    const chip = document.createElement('div');
    chip.className = 'tab-chip';
    const entry = tabs[tabId];
    const title = entry && entry.sidebarTab
      ? entry.sidebarTab.querySelector('.tab-title')?.textContent || `Tab ${tabId}`
      : `Tab ${tabId}`;
    chip.innerHTML = `<span>${title}</span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'chip-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      const idx = attachedTabIds.indexOf(tabId);
      if (idx !== -1) attachedTabIds.splice(idx, 1);
      renderAttachedTabs();
    });
    chip.appendChild(removeBtn);
    attachedTabs.appendChild(chip);
  }
}

logToggle.addEventListener('click', () => {
  logPanel.classList.toggle('open');
  logResizeHandle.style.display = logPanel.classList.contains('open') ? '' : 'none';
});
logResizeHandle.style.display = 'none';

// --- Sidebar resize ---
sidebarResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sidebarResizeHandle.classList.add('active');
  const startX = e.clientX;
  const startWidth = sidebar.getBoundingClientRect().width;

  function onMouseMove(e) {
    const newWidth = Math.max(160, Math.min(500, startWidth + e.clientX - startX));
    sidebar.style.width = newWidth + 'px';
  }
  function onMouseUp() {
    sidebarResizeHandle.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

// --- Log panel resize ---
logResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  logResizeHandle.classList.add('active');
  const startY = e.clientY;
  const startHeight = logPanel.getBoundingClientRect().height;

  function onMouseMove(e) {
    const newHeight = Math.max(80, Math.min(600, startHeight + startY - e.clientY));
    logPanel.style.height = newHeight + 'px';
  }
  function onMouseUp() {
    logResizeHandle.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

// --- Navigation buttons ---
navBack.addEventListener('click', () => {
  if (activeTabId === null) return;
  const entry = tabs[activeTabId];
  if (entry && entry.webview) entry.webview.goBack();
});
navForward.addEventListener('click', () => {
  if (activeTabId === null) return;
  const entry = tabs[activeTabId];
  if (entry && entry.webview) entry.webview.goForward();
});
navRefresh.addEventListener('click', () => {
  if (activeTabId === null) return;
  const entry = tabs[activeTabId];
  if (entry && entry.webview) entry.webview.reload();
});

function updateNavButtons() {
  if (activeTabId === null || !tabs[activeTabId] || !tabs[activeTabId].webview) {
    navBack.disabled = true;
    navForward.disabled = true;
    navRefresh.disabled = true;
    return;
  }
  const wv = tabs[activeTabId].webview;
  navRefresh.disabled = false;
  try { navBack.disabled = !wv.canGoBack(); } catch (_) { navBack.disabled = true; }
  try { navForward.disabled = !wv.canGoForward(); } catch (_) { navForward.disabled = true; }
}

// --- Theme toggle ---
let currentTheme = 'system'; // 'system', 'light', 'dark'

themeToggle.addEventListener('click', () => {
  if (currentTheme === 'system') currentTheme = 'dark';
  else if (currentTheme === 'dark') currentTheme = 'light';
  else currentTheme = 'system';
  applyTheme();
});

function applyTheme() {
  document.body.classList.remove('theme-light', 'theme-dark');
  if (currentTheme === 'light') {
    document.body.classList.add('theme-light');
    themeToggle.innerHTML = '&#x2600;'; // sun
    themeToggle.title = 'Theme: Light (click for System)';
  } else if (currentTheme === 'dark') {
    document.body.classList.add('theme-dark');
    themeToggle.innerHTML = '&#x263E;'; // moon
    themeToggle.title = 'Theme: Dark (click for Light)';
  } else {
    themeToggle.innerHTML = '&#x25D1;'; // half circle
    themeToggle.title = 'Theme: System (click for Dark)';
  }
}
applyTheme();

// --- Task history (terminal-style up/down arrow) ---
const taskHistoryList = JSON.parse(localStorage.getItem('vroomTaskHistory') || '[]');
let historyIndex = -1;
let savedDraft = '';

function addToTaskHistory(text) {
  const idx = taskHistoryList.indexOf(text);
  if (idx !== -1) taskHistoryList.splice(idx, 1);
  taskHistoryList.unshift(text);
  if (taskHistoryList.length > 50) taskHistoryList.pop();
  localStorage.setItem('vroomTaskHistory', JSON.stringify(taskHistoryList));
  historyIndex = -1;
  savedDraft = '';
}

const tabs = {};
const agentTabs = {};
let nextAgentId = null;
let activeTabId = null;
let nextUserTabId = -1; // negative IDs for user tabs
let currentTaskGroup = null; // { el, tabsContainer, dot, tabIds }
const taskGroups = []; // all task groups for cleanup

document.getElementById('newTabBtn').addEventListener('click', () => {
  createUserTab();
});

urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (activeTabId === null) return;
    const entry = tabs[activeTabId];
    if (!entry || !entry.webview) return;
    let url = urlBar.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    entry.webview.loadURL(url);
    urlBar.blur();
  }
});

runBtn.addEventListener('click', async () => {
  const text = taskInput.value.trim();
  if (!text) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  let tabInfo = undefined;
  if (attachedTabIds.length > 0) {
    tabInfo = [];
    for (const tabId of attachedTabIds) {
      const entry = tabs[tabId];
      const info = { id: tabId, title: 'Unknown', url: '' };
      if (entry && entry.webview) {
        try { info.url = entry.webview.getURL(); } catch (_) {}
        try {
          const title = entry.sidebarTab?.querySelector('.tab-title')?.textContent;
          if (title) info.title = title;
        } catch (_) {}
        // Capture screenshot via main process CDP
        try {
          const b64 = await window.vroom.captureTab(tabId);
          if (b64) info.screenshot = b64;
        } catch (_) {}
      }
      tabInfo.push(info);
    }
  }

  window.vroom.sendTask(text, tabInfo);
  runBtn.disabled = true;
  log('Task: ' + text + (attachedTabIds.length > 0 ? ` [with tabs: ${attachedTabIds.join(', ')}]` : ''));
  addToTaskHistory(text);
  createTaskGroup(text);
  taskInput.value = '';
  taskInput.style.height = 'auto';
  attachedTabIds.length = 0;
  renderAttachedTabs();
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runBtn.click();
  } else if (e.key === 'ArrowUp' && taskHistoryList.length > 0) {
    e.preventDefault();
    if (historyIndex === -1) savedDraft = taskInput.value;
    if (historyIndex < taskHistoryList.length - 1) {
      historyIndex++;
      taskInput.value = taskHistoryList[historyIndex];
      taskInput.style.height = 'auto';
      taskInput.style.height = Math.min(taskInput.scrollHeight, 160) + 'px';
    }
  } else if (e.key === 'ArrowDown' && historyIndex >= 0) {
    e.preventDefault();
    historyIndex--;
    taskInput.value = historyIndex >= 0 ? taskHistoryList[historyIndex] : savedDraft;
    taskInput.style.height = 'auto';
    taskInput.style.height = Math.min(taskInput.scrollHeight, 160) + 'px';
  }
});

taskInput.addEventListener('input', () => {
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 160) + 'px';
});

function switchToTab(tabId) {
  activeTabId = tabId;
  grid.classList.add('hidden');
  for (const id in tabs) {
    const isTarget = (id == tabId); // loose comparison for string/int
    tabs[id].sidebarTab.classList.toggle('focused', isTarget);
    if (tabs[id].webview) {
      tabs[id].webview.classList.toggle('focused', isTarget);
    }
  }
  updateUrlBar();
  updateNavButtons();
}

function switchToGrid() {
  activeTabId = null;
  grid.classList.remove('hidden');
  for (const id in tabs) {
    tabs[id].sidebarTab.classList.remove('focused');
    if (tabs[id].webview) {
      tabs[id].webview.classList.remove('focused');
    }
  }
  urlBar.value = '';
  updateNavButtons();
}

function updateUrlBar() {
  if (activeTabId !== null && tabs[activeTabId] && tabs[activeTabId].webview) {
    try {
      urlBar.value = tabs[activeTabId].webview.getURL() || '';
    } catch (_) {
      urlBar.value = '';
    }
  }
}

window.vroom.onMessage((msg) => {
  if (msg.type === 'status') {
    statusText.textContent = msg.message;

    const spawnMatch = msg.message.match(/Spawned executor (exec_\d+): (.+)/);
    if (spawnMatch) {
      nextAgentId = spawnMatch[1];
    }

    // Handle spawn on existing tab — move it into the current task group
    const spawnOnTabMatch = msg.message.match(/Spawned executor (exec_\d+) on tab (-?\d+): (.+)/);
    if (spawnOnTabMatch) {
      const executorId = spawnOnTabMatch[1];
      const existingTabId = parseInt(spawnOnTabMatch[2]);
      if (tabs[existingTabId] && currentTaskGroup) {
        // Move sidebar tab into the task group
        const sidebarTab = tabs[existingTabId].sidebarTab;
        currentTaskGroup.tabsContainer.appendChild(sidebarTab);
        currentTaskGroup.tabIds.push(existingTabId);
        // Map executor to tab for speech
        agentTabs[executorId] = existingTabId;
      }
    }

    const tabMatch = msg.message.match(/\[Tab (-?\d+)\] (.+)/);
    if (tabMatch) {
      const tabId = parseInt(tabMatch[1]);
      const detail = tabMatch[2];
      if (tabs[tabId]) {
        if (tabs[tabId].stepInfo) tabs[tabId].stepInfo.textContent = detail;
        if (tabs[tabId].sidebarStep) tabs[tabId].sidebarStep.textContent = detail;
        if (detail.startsWith('Done:')) {
          if (tabs[tabId].statusEl) {
            tabs[tabId].statusEl.textContent = 'Done';
            tabs[tabId].statusEl.classList.add('done');
          }
          if (tabs[tabId].card) tabs[tabId].card.classList.remove('active');
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
    if (currentTaskGroup) {
      currentTaskGroup.el.classList.add('complete');
      currentTaskGroup = null;
    }

  } else if (msg.type === 'tab_screenshot') {
    const tabId = msg.tabId;
    if (tabs[tabId]) {
      tabs[tabId].img.src = 'data:image/jpeg;base64,' + msg.data;
    }

  } else if (msg.type === 'create_webviews') {
    for (let i = 0; i < msg.tabIds.length; i++) {
      const tabId = msg.tabIds[i];
      createTabCard(tabId, msg.task);

      const webview = document.createElement('webview');
      webview.src = msg.url;
      webviewLayer.appendChild(webview);

      tabs[tabId].webview = webview;

      webview.addEventListener('dom-ready', () => {
        window.vroom.registerWebview(tabId, webview.getWebContentsId(), msg.requestId);
      });

      webview.addEventListener('did-navigate', () => {
        if (activeTabId == tabId) {
          updateUrlBar();
          updateNavButtons();
        }
      });

      webview.addEventListener('page-favicon-updated', (e) => {
        if (e.favicons && e.favicons.length > 0 && tabs[tabId] && tabs[tabId].sidebarFavicon) {
          tabs[tabId].sidebarFavicon.src = e.favicons[0];
          tabs[tabId].sidebarFavicon.classList.add('visible');
        }
      });

      if (nextAgentId) {
        agentTabs[nextAgentId] = tabId;
        nextAgentId = null;
      }
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
  }
});

function createTaskGroup(taskText) {
  const group = document.createElement('div');
  group.className = 'task-group';

  const header = document.createElement('button');
  header.className = 'task-group-header';

  const dot = document.createElement('div');
  dot.className = 'task-group-dot';

  const label = document.createElement('span');
  label.className = 'task-group-label';
  label.textContent = taskText.length > 35 ? taskText.substring(0, 35) + '...' : taskText;
  label.title = taskText;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';

  header.appendChild(dot);
  header.appendChild(label);
  header.appendChild(closeBtn);

  header.addEventListener('click', (e) => {
    if (e.target === closeBtn) return;
    switchToGrid();
  });

  const taskGroupData = { el: group, tabsContainer: null, dot, tabIds: [] };

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTaskGroup(taskGroupData);
  });

  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'task-group-tabs';
  taskGroupData.tabsContainer = tabsContainer;

  group.appendChild(header);
  group.appendChild(tabsContainer);

  // Insert at the top of the tab list
  tabList.insertBefore(group, tabList.firstChild);

  currentTaskGroup = taskGroupData;
  taskGroups.push(taskGroupData);
}

function closeTaskGroup(groupData) {
  // Close all agent tabs in this group
  const idsToClose = [...groupData.tabIds];
  if (idsToClose.length > 0) {
    window.vroom.closeTabs(idsToClose);
  }
  for (const tabId of idsToClose) {
    removeTabCard(tabId);
  }
  groupData.el.remove();
  if (currentTaskGroup === groupData) {
    currentTaskGroup = null;
  }
  const idx = taskGroups.indexOf(groupData);
  if (idx !== -1) taskGroups.splice(idx, 1);
}

function createTabCard(tabId, task) {
  if (tabs[tabId]) return;
  emptyState.style.display = 'none';

  // Sidebar tab
  const sidebarTab = document.createElement('button');
  sidebarTab.className = 'sidebar-tab';

  const sidebarFavicon = document.createElement('img');
  sidebarFavicon.className = 'tab-favicon';

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

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close this single agent tab
    window.vroom.closeTabs([tabId]);
    removeTabCard(tabId);
  });

  sidebarTab.appendChild(sidebarFavicon);
  sidebarTab.appendChild(sidebarDot);
  sidebarTab.appendChild(tabInfo);
  sidebarTab.appendChild(sidebarBadge);
  sidebarTab.appendChild(closeBtn);

  sidebarTab.draggable = true;
  sidebarTab.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/tab-id', String(tabId));
    e.dataTransfer.effectAllowed = 'link';
  });

  sidebarTab.addEventListener('click', () => {
    if (activeTabId === tabId) {
      switchToGrid();
    } else {
      switchToTab(tabId);
    }
  });

  // Nest agent tabs inside the current task group
  if (currentTaskGroup) {
    currentTaskGroup.tabsContainer.appendChild(sidebarTab);
    currentTaskGroup.tabIds.push(tabId);
  } else {
    tabList.appendChild(sidebarTab);
  }

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
    sidebarTab, sidebarDot, sidebarStep, sidebarBadge, sidebarFavicon,
    webview: null,
  };
}

function removeTabCard(tabId) {
  if (!tabs[tabId]) return;
  if (activeTabId === tabId) switchToGrid();
  if (tabs[tabId].card) tabs[tabId].card.remove();
  tabs[tabId].sidebarTab.remove();
  if (tabs[tabId].webview) {
    tabs[tabId].webview.remove();
  }
  delete tabs[tabId];

  // Remove from task group tracking
  for (const group of taskGroups) {
    const idx = group.tabIds.indexOf(tabId);
    if (idx !== -1) {
      group.tabIds.splice(idx, 1);
      break;
    }
  }

  const hasAgentTabs = Object.keys(tabs).some(id => parseInt(id) > 0);
  if (!hasAgentTabs) {
    emptyState.style.display = '';
  }
}

function createUserTab() {
  const tabId = nextUserTabId--;

  const sidebarTab = document.createElement('button');
  sidebarTab.className = 'sidebar-tab';

  const sidebarFavicon = document.createElement('img');
  sidebarFavicon.className = 'tab-favicon';

  const sidebarDot = document.createElement('div');
  sidebarDot.className = 'tab-dot';
  sidebarDot.style.background = 'var(--text-tertiary)';

  const tabInfo = document.createElement('div');
  tabInfo.className = 'tab-info';

  const sidebarTitle = document.createElement('span');
  sidebarTitle.className = 'tab-title';
  sidebarTitle.textContent = 'New Tab';

  tabInfo.appendChild(sidebarTitle);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTabCard(tabId);
  });

  sidebarTab.appendChild(sidebarFavicon);
  sidebarTab.appendChild(sidebarDot);
  sidebarTab.appendChild(tabInfo);
  sidebarTab.appendChild(closeBtn);

  sidebarTab.draggable = true;
  sidebarTab.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/tab-id', String(tabId));
    e.dataTransfer.effectAllowed = 'link';
  });

  sidebarTab.addEventListener('click', () => {
    if (activeTabId === tabId) {
      switchToGrid();
    } else {
      switchToTab(tabId);
    }
  });

  tabList.appendChild(sidebarTab);

  const webview = document.createElement('webview');
  webview.src = 'https://www.google.com';
  webviewLayer.appendChild(webview);

  // Register with the server so it can screenshot/control this tab (once only)
  webview.addEventListener('dom-ready', () => {
    window.vroom.registerWebview(tabId, webview.getWebContentsId(), 'user');
  }, { once: true });

  // Update sidebar title and URL bar when the webview navigates
  webview.addEventListener('page-title-updated', (e) => {
    const title = e.title || 'New Tab';
    sidebarTitle.textContent = title.length > 40 ? title.substring(0, 40) + '...' : title;
    sidebarTitle.title = title;
  });

  webview.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons.length > 0) {
      sidebarFavicon.src = e.favicons[0];
      sidebarFavicon.classList.add('visible');
    }
  });

  webview.addEventListener('did-navigate', () => {
    if (activeTabId == tabId) {
      updateUrlBar();
      updateNavButtons();
    }
  });

  tabs[tabId] = {
    card: null, img: null, label: null, statusEl: null,
    stepInfo: null, speechIndicator: null,
    sidebarTab, sidebarDot, sidebarStep: null, sidebarBadge: null, sidebarFavicon,
    webview,
    isUserTab: true,
  };

  switchToTab(tabId);
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
