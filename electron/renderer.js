const tabList = document.getElementById('tabList');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const newTaskBtn2 = document.getElementById('newTaskBtn2');
const logEntries = document.getElementById('logEntries');
const webviewLayer = document.getElementById('webviewLayer');

const urlBar = document.getElementById('urlBar');
const logToggle = document.getElementById('logToggle');
const logPanel = document.getElementById('logPanel');
const chatSidebar = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const navBack = document.getElementById('navBack');
const navForward = document.getElementById('navForward');
const navRefresh = document.getElementById('navRefresh');
const themeToggle = document.getElementById('themeToggle');

const pauseBtn = document.getElementById('pauseBtn');
const gridControls = document.getElementById('gridControls');
const takeControlBtn = document.getElementById('takeControlBtn');
const tabChat = document.getElementById('tabChat');
const tabContracts = document.getElementById('tabContracts');
const panelChat = document.getElementById('panelChat');
const panelContracts = document.getElementById('panelContracts');
const contractsList = document.getElementById('contractsList');

const sidebarResizeHandle = document.getElementById('sidebarResizeHandle');
const logResizeHandle = document.getElementById('logResizeHandle');
const sidebar = document.querySelector('.sidebar');

// --- Workspace state ---
let workspaceActive = false;
let firstMessageSent = false;

// --- Drag & drop tabs into grid ---
grid.addEventListener('dragover', (e) => {
  e.preventDefault();
  grid.classList.add('drag-over');
});
grid.addEventListener('dragleave', () => {
  grid.classList.remove('drag-over');
});
grid.addEventListener('drop', (e) => {
  e.preventDefault();
  grid.classList.remove('drag-over');
  const tabId = parseInt(e.dataTransfer.getData('text/tab-id'));
  if (!tabId || isNaN(tabId)) return;
  if (!tabs[tabId] || !tabs[tabId].isUserTab) return;
  if (!currentTaskGroup) return;
  if (currentTaskGroup.tabIds.includes(tabId)) return;
  addTabToWorkspace(tabId);
});

async function addTabToWorkspace(tabId) {
  const entry = tabs[tabId];
  if (!entry) return;
  // Move sidebar tab into task group
  if (currentTaskGroup) {
    currentTaskGroup.tabsContainer.appendChild(entry.sidebarTab);
    currentTaskGroup.tabIds.push(tabId);
  }
  // Create an unattached grid card
  createGridCard(tabId, entry.sidebarTab.querySelector('.tab-title')?.textContent || `Tab ${tabId}`, true);
  // Capture and show current screenshot
  const screenshot = await window.vroom.captureTab(tabId);
  if (screenshot && tabs[tabId] && tabs[tabId].img) {
    tabs[tabId].img.src = 'data:image/jpeg;base64,' + screenshot;
  }
}

function sortGrid() {
  const cards = [...grid.querySelectorAll('.tab-card')];
  cards.sort((a, b) => {
    const aAttached = a.dataset.attached === 'true' ? 0 : 1;
    const bAttached = b.dataset.attached === 'true' ? 0 : 1;
    return aAttached - bAttached;
  });
  for (const card of cards) grid.appendChild(card);
}

function getWorkspaceTabInfo() {
  if (!currentTaskGroup) return [];
  const tabInfo = [];
  for (const tabId of currentTaskGroup.tabIds) {
    const entry = tabs[tabId];
    if (!entry || !entry.isUserTab) continue;
    const info = { id: tabId, title: 'Unknown', url: '' };
    if (entry.webview) {
      try { info.url = entry.webview.getURL(); } catch (_) {}
      try {
        const title = entry.sidebarTab?.querySelector('.tab-title')?.textContent;
        if (title) info.title = title;
      } catch (_) {}
    }
    tabInfo.push(info);
  }
  return tabInfo;
}

logToggle.addEventListener('click', () => {
  logPanel.classList.toggle('open');
  logResizeHandle.style.display = logPanel.classList.contains('open') ? '' : 'none';
});
logResizeHandle.style.display = 'none';

chatSendBtn.addEventListener('click', async () => {
  const text = chatInput.value.trim();
  if (!text) return;
  appendChatMessage('You', text, true);
  chatInput.value = '';

  if (workspaceActive && !firstMessageSent) {
    // First message triggers extractor
    const tabInfo = getWorkspaceTabInfo();
    window.vroom.sendTask(text, tabInfo.length > 0 ? tabInfo : undefined);
    firstMessageSent = true;
    currentTaskText = text;
    addToTaskHistory(text);

    // Update task group label
    if (currentTaskGroup) {
      const label = currentTaskGroup.el.querySelector('.task-group-label');
      if (label) {
        label.textContent = text.length > 35 ? text.substring(0, 35) + '...' : text;
        label.title = text;
      }
    }
    chatInput.placeholder = 'Message extractor...';
  } else {
    window.vroom.sendLog(text);
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    chatSendBtn.click();
  }
});

let agentsPaused = false;
pauseBtn.addEventListener('click', () => {
  agentsPaused = !agentsPaused;
  if (agentsPaused) {
    window.vroom.pauseAgents();
    pauseBtn.classList.add('active');
    pauseBtn.title = 'Resume agents';
    pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
  } else {
    window.vroom.resumeAgents();
    pauseBtn.classList.remove('active');
    pauseBtn.title = 'Pause agents';
    pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  }
});

// --- Visual preempt ---
let visualPreemptActive = false;
let visualPreemptTabId = null;
let visualPreemptAgentId = null;
let visualPreemptInteractions = [];
let visualPreemptConsoleHandler = null;

function updateTakeControlBtn() {
  if (activeTabId !== null) {
    let hasAgent = false;
    for (const [aid, tid] of Object.entries(agentTabs)) {
      if (tid == activeTabId) { hasAgent = true; break; }
    }
    if (hasAgent) {
      takeControlBtn.classList.remove('hidden');
      return;
    }
  }
  takeControlBtn.classList.add('hidden');
}

takeControlBtn.addEventListener('click', async () => {
  if (!visualPreemptActive) {
    // Start visual preempt
    const tabId = activeTabId;
    let agentId = null;
    for (const [aid, tid] of Object.entries(agentTabs)) {
      if (tid == tabId) { agentId = aid; break; }
    }
    if (!agentId) return;

    visualPreemptActive = true;
    visualPreemptTabId = tabId;
    visualPreemptAgentId = agentId;
    visualPreemptInteractions = [];

    window.vroom.visualPreemptStart(tabId, agentId);

    // Inject click listener into webview
    const entry = tabs[tabId];
    if (entry && entry.webview) {
      entry.webview.executeJavaScript(`
        window.__vroomClickCapture = function(e) {
          console.log('__vroom_click__' + JSON.stringify({x: e.clientX, y: e.clientY}));
        };
        document.addEventListener('click', window.__vroomClickCapture, true);
      `);

      visualPreemptConsoleHandler = (e) => {
        if (e.message && e.message.startsWith('__vroom_click__')) {
          const data = JSON.parse(e.message.replace('__vroom_click__', ''));
          // Capture screenshot after click
          setTimeout(() => {
            window.vroom.captureTab(tabId).then(screenshot => {
              if (screenshot) {
                visualPreemptInteractions.push({
                  type: 'click',
                  x: data.x,
                  y: data.y,
                  screenshot
                });
                log(`Visual preempt: click at (${data.x}, ${data.y}) — ${visualPreemptInteractions.length} interaction(s)`, true);
              }
            });
          }, 300); // small delay to let page update after click
        }
      };
      entry.webview.addEventListener('console-message', visualPreemptConsoleHandler);
    }

    // Update button to "Continue"
    takeControlBtn.classList.add('active');
    takeControlBtn.title = 'Give back control';
    takeControlBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
    log('Visual preempt: took control', true);
  } else {
    endVisualPreempt();
  }
});

function endVisualPreempt() {
  if (!visualPreemptActive) return;

  // Send interactions to server
  window.vroom.visualPreemptEnd(visualPreemptTabId, visualPreemptAgentId, visualPreemptInteractions);

  // Remove click listener from webview
  const entry = tabs[visualPreemptTabId];
  if (entry && entry.webview) {
    entry.webview.executeJavaScript(`
      if (window.__vroomClickCapture) {
        document.removeEventListener('click', window.__vroomClickCapture, true);
        delete window.__vroomClickCapture;
      }
    `);
    if (visualPreemptConsoleHandler) {
      entry.webview.removeEventListener('console-message', visualPreemptConsoleHandler);
    }
  }

  log(`Visual preempt: gave back control (${visualPreemptInteractions.length} interaction(s))`, true);

  visualPreemptActive = false;
  visualPreemptTabId = null;
  visualPreemptAgentId = null;
  visualPreemptInteractions = [];
  visualPreemptConsoleHandler = null;

  // Reset button
  takeControlBtn.classList.remove('active');
  takeControlBtn.title = 'Take control';
  takeControlBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 2l12 10h-6l4 8-3 1-4-8-3 3z"/></svg>';
}

// Panel tab switching
tabChat.addEventListener('click', () => {
  tabChat.classList.add('active');
  tabContracts.classList.remove('active');
  panelChat.classList.remove('hidden');
  panelContracts.classList.add('hidden');
});
tabContracts.addEventListener('click', () => {
  tabContracts.classList.add('active');
  tabChat.classList.remove('active');
  panelContracts.classList.remove('hidden');
  panelChat.classList.add('hidden');
});

// Contracts state
const contracts = {}; // executorId -> contract data

function renderContract(data) {
  contracts[data.executorId] = data;
  let card = document.getElementById(`contract-${data.executorId}`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'contract-card';
    card.id = `contract-${data.executorId}`;
    contractsList.appendChild(card);
  }

  let html = `<div class="contract-header">
    <span class="contract-agent">${data.agentName}</span>
    <span class="contract-task" title="${data.task}">${data.task}</span>
  </div>`;

  for (const c of data.commitments) {
    const icon = c.status === 'done' ? '\u2713' : c.status === 'failed' ? '\u2717' : '\u25cb';
    html += `<div class="commitment ${c.status}"><span class="c-icon">${icon}</span>${c.text}</div>`;
  }

  if (data.memos && data.memos.length > 0) {
    html += '<div class="contract-memos">';
    for (const m of data.memos) {
      html += `<div class="memo">${m.text}</div>`;
    }
    html += '</div>';
  }

  card.innerHTML = html;
}

function appendChatMessage(sender, message, isUser) {
  const msg = document.createElement('div');
  msg.className = 'chat-msg ' + (isUser ? 'user' : 'agent');
  const senderEl = document.createElement('div');
  senderEl.className = 'chat-sender';
  senderEl.textContent = sender;
  const textEl = document.createElement('div');
  textEl.textContent = message;
  msg.appendChild(senderEl);
  msg.appendChild(textEl);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Store in current task group's chat history
  if (currentTaskGroup) {
    currentTaskGroup.chatHistory.push({ sender, message, isUser });
  }
}

function loadChatForTaskGroup(taskGroup) {
  chatMessages.innerHTML = '';
  if (!taskGroup) return;
  for (const entry of taskGroup.chatHistory) {
    const msg = document.createElement('div');
    msg.className = 'chat-msg ' + (entry.isUser ? 'user' : 'agent');
    const senderEl = document.createElement('div');
    senderEl.className = 'chat-sender';
    senderEl.textContent = entry.sender;
    const textEl = document.createElement('div');
    textEl.textContent = entry.message;
    msg.appendChild(senderEl);
    msg.appendChild(textEl);
    chatMessages.appendChild(msg);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
const taskHistoryList = JSON.parse(localStorage.getItem('vroomTaskHistory') || '[]').map(entry => {
  if (typeof entry === 'string') return { text: entry, status: 'success', timestamp: Date.now() };
  // Mark stale running tasks as failed (older than 1 hour)
  if (entry.status === 'running' && Date.now() - entry.timestamp > 3600000) entry.status = 'failed';
  return entry;
});
localStorage.setItem('vroomTaskHistory', JSON.stringify(taskHistoryList));
let historyIndex = -1;
let savedDraft = '';

function addToTaskHistory(text) {
  const idx = taskHistoryList.findIndex(e => e.text === text);
  if (idx !== -1) taskHistoryList.splice(idx, 1);
  taskHistoryList.unshift({ text, status: 'running', timestamp: Date.now() });
  if (taskHistoryList.length > 50) taskHistoryList.pop();
  localStorage.setItem('vroomTaskHistory', JSON.stringify(taskHistoryList));
  historyIndex = -1;
  savedDraft = '';
}

function updateTaskHistoryStatus(text, status) {
  const entry = taskHistoryList.find(e => e.text === text && e.status === 'running');
  if (entry) {
    entry.status = status;
    localStorage.setItem('vroomTaskHistory', JSON.stringify(taskHistoryList));
  }
}

// --- Frequently visited sites ---
const frequentSites = JSON.parse(localStorage.getItem('vroomFrequentSites') || '{}');

function trackSiteVisit(url, favicon, title) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    const hostname = parsed.hostname;
    if (!hostname) return;
    const entry = frequentSites[hostname] || { count: 0, favicon: '', title: '' };
    entry.count++;
    if (favicon) entry.favicon = favicon;
    if (title) entry.title = title;
    frequentSites[hostname] = entry;
    // Cap at 100 entries
    const keys = Object.keys(frequentSites);
    if (keys.length > 100) {
      const sorted = keys.sort((a, b) => frequentSites[a].count - frequentSites[b].count);
      delete frequentSites[sorted[0]];
    }
    localStorage.setItem('vroomFrequentSites', JSON.stringify(frequentSites));
  } catch (_) {}
}

function updateSiteFavicon(url, favicon) {
  try {
    const hostname = new URL(url).hostname;
    if (frequentSites[hostname]) {
      frequentSites[hostname].favicon = favicon;
      localStorage.setItem('vroomFrequentSites', JSON.stringify(frequentSites));
    }
  } catch (_) {}
}

const tabs = {};
const agentTabs = {};
let nextAgentId = null;
let activeTabId = null;
let nextUserTabId = -1; // negative IDs for user tabs
let currentTaskGroup = null; // { el, tabsContainer, dot, tabIds }
let currentTaskText = ''; // track for history status updates
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

newTaskBtn2.addEventListener('click', () => {
  if (audioCtx.state === 'suspended') audioCtx.resume();

  createTaskGroup('New Task');
  // Clear chat and grid for new session
  chatMessages.innerHTML = '';
  rebuildGridForTaskGroup(currentTaskGroup);
  switchToGrid();
  emptyState.style.display = 'none';
  chatSidebar.classList.remove('hidden');
  gridControls.classList.add('visible');

  workspaceActive = true;
  firstMessageSent = false;
  chatInput.placeholder = 'Describe your task...';
  chatInput.focus();
});

function switchToTab(tabId) {
  if (visualPreemptActive && visualPreemptTabId != tabId) endVisualPreempt();
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
  updateTakeControlBtn();
}

function switchToTaskGroup(taskGroup) {
  currentTaskGroup = taskGroup;
  loadChatForTaskGroup(taskGroup);
  // Rebuild grid to show only this group's tabs
  rebuildGridForTaskGroup(taskGroup);
  switchToGrid();
}

function rebuildGridForTaskGroup(taskGroup) {
  // Remove all tab-cards from grid (keep emptyState)
  grid.querySelectorAll('.tab-card').forEach(c => c.remove());
  if (!taskGroup) return;
  let hasCards = false;
  for (const tabId of taskGroup.tabIds) {
    if (tabs[tabId] && tabs[tabId].card) {
      grid.appendChild(tabs[tabId].card);
      hasCards = true;
    }
  }
  if (hasCards) {
    emptyState.style.display = 'none';
  }
}

function switchToGrid() {
  if (visualPreemptActive) endVisualPreempt();
  activeTabId = null;
  grid.classList.remove('hidden');
  chatSidebar.classList.remove('hidden');
  gridControls.classList.add('visible');
  takeControlBtn.classList.add('hidden');
  // Hide home page if grid has cards
  if (grid.querySelector('.tab-card')) {
    emptyState.style.display = 'none';
  }
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

    // Show extractor messages in chat
    if (msg.message.startsWith('Extractor: ')) {
      appendChatMessage('Extractor', msg.message.substring(11), false);
    }

    // Handle spawn on existing tab — move it into the current task group and create a grid card
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

        // Create a grid card if this tab doesn't have one (user tabs)
        if (!tabs[existingTabId].card) {
          createGridCard(existingTabId, spawnOnTabMatch[3]);
        }
        // Mark as attached and sort
        if (tabs[existingTabId].card) {
          tabs[existingTabId].card.dataset.attached = 'true';
          tabs[existingTabId].card.classList.remove('unattached');
          sortGrid();
        }
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
          // Mark grid card as done but keep it visible
          if (tabs[tabId].card) {
            tabs[tabId].card.classList.add('done');
            tabs[tabId].card.dataset.attached = 'false';
            if (tabs[tabId].statusEl) {
              tabs[tabId].statusEl.textContent = 'Done';
              tabs[tabId].statusEl.classList.add('done');
            }
          }
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
    workspaceActive = false;
    firstMessageSent = false;
    chatInput.placeholder = 'Message agents...';
    log('Complete: ' + msg.summary, true);
    if (currentTaskText) {
      updateTaskHistoryStatus(currentTaskText, 'success');
      currentTaskText = '';
    }
    if (currentTaskGroup) {
      currentTaskGroup.el.classList.add('complete');
      // Keep currentTaskGroup so the grid view stays visible with done cards
    }

  } else if (msg.type === 'tab_screenshot') {
    const tabId = msg.tabId;
    if (tabs[tabId] && tabs[tabId].img) {
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
        try { trackSiteVisit(webview.getURL(), '', ''); } catch (_) {}
      });

      webview.addEventListener('page-favicon-updated', (e) => {
        if (e.favicons && e.favicons.length > 0 && tabs[tabId] && tabs[tabId].sidebarFavicon) {
          tabs[tabId].sidebarFavicon.src = e.favicons[0];
          tabs[tabId].sidebarFavicon.classList.add('visible');
          try { updateSiteFavicon(webview.getURL(), e.favicons[0]); } catch (_) {}
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

  } else if (msg.type === 'audio_chunk') {
    if (msg.data) queueAudioChunk(msg.data, msg.agentId);
    if (msg.done) log(`[${msg.agentId}] Speech complete`);

  } else if (msg.type === 'audio') {
    playAudio(msg.data, msg.agentId);

  } else if (msg.type === 'clear_audio') {
    stopAllAudio();

  } else if (msg.type === 'log') {
    if (msg.agentId !== 'user') {
      appendChatMessage(msg.agentId, msg.message, false);
    }

  } else if (msg.type === 'contract_update') {
    renderContract(msg);

  } else if (msg.type === 'preempt_transcript') {
    log('You said: ' + msg.text, true);

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
    switchToTaskGroup(taskGroupData);
  });

  const taskGroupData = { el: group, tabsContainer: null, dot, tabIds: [], chatHistory: [] };

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
  chatSidebar.classList.remove('hidden');
  gridControls.classList.add('visible');

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
  card.dataset.attached = 'true';

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

function createGridCard(tabId, task, unattached = false) {
  emptyState.style.display = 'none';
  chatSidebar.classList.remove('hidden');
  gridControls.classList.add('visible');

  const card = document.createElement('div');
  card.className = 'tab-card active' + (unattached ? ' unattached' : '');
  card.dataset.attached = unattached ? 'false' : 'true';

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
  placeholder.textContent = unattached ? '' : 'Waiting for stream...';

  img.addEventListener('load', () => {
    img.style.display = 'block';
    placeholder.style.display = 'none';
  });

  screenshotContainer.appendChild(img);
  screenshotContainer.appendChild(placeholder);

  const stepInfo = document.createElement('div');
  stepInfo.className = 'step-info';
  stepInfo.textContent = unattached ? '' : 'Starting...';

  card.appendChild(header);
  card.appendChild(screenshotContainer);
  card.appendChild(stepInfo);

  grid.appendChild(card);

  // Attach grid card elements to the existing tab entry
  const entry = tabs[tabId];
  entry.card = card;
  entry.img = img;
  entry.label = label;
  entry.statusEl = statusEl;
  entry.stepInfo = stepInfo;
  entry.speechIndicator = speechIndicator;

  // Add sidebar step + badge if missing (user tabs don't have these)
  if (!unattached) {
    if (!entry.sidebarStep) {
      const sidebarStep = document.createElement('span');
      sidebarStep.className = 'tab-step';
      sidebarStep.textContent = 'Starting...';
      const tabInfo = entry.sidebarTab.querySelector('.tab-info');
      if (tabInfo) tabInfo.appendChild(sidebarStep);
      entry.sidebarStep = sidebarStep;
    }
    if (!entry.sidebarBadge) {
      const sidebarBadge = document.createElement('span');
      sidebarBadge.className = 'tab-badge';
      sidebarBadge.textContent = 'Running';
      const closeBtn = entry.sidebarTab.querySelector('.tab-close');
      entry.sidebarTab.insertBefore(sidebarBadge, closeBtn);
      entry.sidebarBadge = sidebarBadge;
    }

    // Update sidebar dot to running
    if (entry.sidebarDot) {
      entry.sidebarDot.className = 'tab-dot running';
      entry.sidebarDot.style.background = '';
    }
  }
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
    showHomePage();
  }
}

function createUserTab(url = 'https://www.google.com') {
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
  webview.src = url;
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
      try { updateSiteFavicon(webview.getURL(), e.favicons[0]); } catch (_) {}
    }
  });

  webview.addEventListener('did-navigate', () => {
    if (activeTabId == tabId) {
      updateUrlBar();
      updateNavButtons();
    }
    try {
      trackSiteVisit(webview.getURL(), sidebarFavicon.src || '', sidebarTitle.textContent || '');
    } catch (_) {}
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
const activeSources = new Set();
let audioNextTime = 0; // scheduled time for next chunk

function decodePCM(b64Data) {
  const raw = atob(b64Data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

function queueAudioChunk(b64Data, agentId) {
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const samples = decodePCM(b64Data);
  const buffer = audioCtx.createBuffer(1, samples.length, 24000);
  buffer.getChannelData(0).set(samples);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.onended = () => activeSources.delete(source);
  activeSources.add(source);

  const now = audioCtx.currentTime;
  if (audioNextTime < now) audioNextTime = now;
  source.start(audioNextTime);
  audioNextTime += buffer.duration;
}

async function playAudio(b64Data, agentId) {
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const samples = decodePCM(b64Data);
  const buffer = audioCtx.createBuffer(1, samples.length, 24000);
  buffer.getChannelData(0).set(samples);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.onended = () => activeSources.delete(source);
  activeSources.add(source);
  source.start();

  log(`[${agentId}] Speaking...`);
}

function stopAllAudio() {
  for (const source of activeSources) {
    try { source.stop(); } catch (_) {}
  }
  activeSources.clear();
  audioNextTime = 0;
}

// --- Unmute / Push-to-talk ---
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

const unmuteBtn = document.getElementById('unmuteBtn');

unmuteBtn.addEventListener('click', async () => {
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recordedChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

        if (workspaceActive && !firstMessageSent) {
          // Send audio as the initial task
          const tabInfo = getWorkspaceTabInfo();
          const audioData = { data: b64, mimeType: 'audio/webm' };
          window.vroom.sendTask('(audio instruction)', tabInfo.length > 0 ? tabInfo : undefined, audioData);
          firstMessageSent = true;
          appendChatMessage('You', '(voice message)', true);
          if (currentTaskGroup) {
            const label = currentTaskGroup.el.querySelector('.task-group-label');
            if (label) {
              label.textContent = 'Voice Task';
              label.title = 'Started with voice instruction';
            }
          }
          chatInput.placeholder = 'Message extractor...';
          log('Sending voice task...', true);
        } else {
          window.vroom.preemptAudio(b64, 'audio/webm');
          log('Sending speech to server...', true);
        }
      };

      // Only send preempt_start if agents are already running
      if (firstMessageSent) {
        window.vroom.preemptStart();
      }
      mediaRecorder.start();
      isRecording = true;
      unmuteBtn.classList.add('active');
      unmuteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      log('Recording...', true);
    } catch (e) {
      log('Mic access denied: ' + e.message);
    }
  } else {
    mediaRecorder.stop();
    if (firstMessageSent) {
      window.vroom.preemptEnd();
    }
    isRecording = false;
    unmuteBtn.classList.remove('active');
    unmuteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
  }
});

function log(text, highlight = false) {
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (highlight ? ' highlight' : '');
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${text}`;
  logEntries.appendChild(entry);
  logEntries.scrollTop = logEntries.scrollHeight;
}

// --- Home page ---
function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function showHomePage() {
  emptyState.style.display = '';
  chatSidebar.classList.add('hidden');
  gridControls.classList.remove('visible');
  takeControlBtn.classList.add('hidden');
  if (visualPreemptActive) endVisualPreempt();
  agentsPaused = false;
  pauseBtn.classList.remove('active');
  pauseBtn.title = 'Pause agents';
  pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  contractsList.innerHTML = '';
  for (const k in contracts) delete contracts[k];
  // Reset to chat tab
  tabChat.classList.add('active');
  tabContracts.classList.remove('active');
  panelChat.classList.remove('hidden');
  panelContracts.classList.add('hidden');
  renderHomePage();
}

function renderHomePage() {
  emptyState.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'home-page';

  // Center: logo
  const center = document.createElement('div');
  center.className = 'home-center';

  const logo = document.createElement('img');
  logo.className = 'home-logo';
  logo.src = 'logo.png';

  center.appendChild(logo);
  page.appendChild(center);

  // Columns
  const columns = document.createElement('div');
  columns.className = 'home-columns';

  // Recent Tasks column
  const recentCol = document.createElement('div');
  recentCol.className = 'home-col';

  const recentTitle = document.createElement('div');
  recentTitle.className = 'home-col-title';
  recentTitle.textContent = 'Recent Tasks';
  recentCol.appendChild(recentTitle);

  const taskList = document.createElement('div');
  taskList.className = 'home-task-list';

  const recentTasks = taskHistoryList.slice(0, 10);
  for (const task of recentTasks) {
    const card = document.createElement('div');
    card.className = 'home-task-card';

    const text = document.createElement('div');
    text.className = 'home-task-text';
    text.textContent = task.text;

    const meta = document.createElement('div');
    meta.className = 'home-task-meta';

    const dot = document.createElement('div');
    dot.className = 'home-task-dot ' + task.status;

    const statusLabel = document.createElement('span');
    statusLabel.className = 'home-task-status';
    statusLabel.textContent = task.status === 'success' ? 'Succeeded' : task.status === 'failed' ? 'Failed' : 'Running';

    const time = document.createElement('span');
    time.className = 'home-task-time';
    time.textContent = relativeTime(task.timestamp);

    meta.appendChild(dot);
    meta.appendChild(statusLabel);
    meta.appendChild(time);
    card.appendChild(text);
    card.appendChild(meta);
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      newTaskBtn2.click();
      chatInput.value = task.text;
      chatInput.focus();
    });
    taskList.appendChild(card);
  }

  if (recentTasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-task-status';
    empty.textContent = 'No tasks yet';
    empty.style.padding = '8px 0';
    taskList.appendChild(empty);
  }

  const recentScroll = document.createElement('div');
  recentScroll.className = 'home-col-scroll';
  recentScroll.appendChild(taskList);
  recentCol.appendChild(recentScroll);
  columns.appendChild(recentCol);

  // Frequently Visited column
  const sitesCol = document.createElement('div');
  sitesCol.className = 'home-col';

  const sitesTitle = document.createElement('div');
  sitesTitle.className = 'home-col-title';
  sitesTitle.textContent = 'Frequently Visited';
  sitesCol.appendChild(sitesTitle);

  const sitesGrid = document.createElement('div');
  sitesGrid.className = 'home-sites-grid';

  const sortedSites = Object.entries(frequentSites)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12);

  for (const [hostname, site] of sortedSites) {
    const tile = document.createElement('div');
    tile.className = 'home-site-tile';
    tile.title = site.title || hostname;

    const favicon = document.createElement('img');
    favicon.className = 'home-site-favicon';
    favicon.src = site.favicon || `https://${hostname}/favicon.ico`;
    favicon.onerror = () => { favicon.style.display = 'none'; };

    const label = document.createElement('div');
    label.className = 'home-site-label';
    label.textContent = hostname;

    tile.appendChild(favicon);
    tile.appendChild(label);

    tile.addEventListener('click', () => {
      createUserTab('https://' + hostname);
    });

    sitesGrid.appendChild(tile);
  }

  if (sortedSites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-task-status';
    empty.textContent = 'No sites yet';
    empty.style.padding = '8px 0';
    sitesGrid.appendChild(empty);
  }

  const sitesScroll = document.createElement('div');
  sitesScroll.className = 'home-col-scroll';
  sitesScroll.appendChild(sitesGrid);
  sitesCol.appendChild(sitesScroll);
  columns.appendChild(sitesCol);
  page.appendChild(columns);

  emptyState.appendChild(page);
}

// Render home page on startup
renderHomePage();

// --- Settings UI ---

const settingsOverlay = document.getElementById('settingsOverlay');
const settingsBtn = document.getElementById('settingsBtn');
const settingsClose = document.getElementById('settingsClose');
const selfhostedUrlRow = document.getElementById('selfhostedUrlRow');
const selfhostedUrl = document.getElementById('selfhostedUrl');
const googleLoginBtn = document.getElementById('googleLoginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const settingsUser = document.getElementById('settingsUser');
const settingsAvatar = document.getElementById('settingsAvatar');
const settingsUserName = document.getElementById('settingsUserName');
const settingsUserEmail = document.getElementById('settingsUserEmail');
const settingsError = document.getElementById('settingsError');
const serverModeRadios = document.querySelectorAll('input[name="serverMode"]');

function showSettings() {
  settingsOverlay.classList.remove('hidden');
  loadSettingsUI();
}

function hideSettings() {
  settingsOverlay.classList.add('hidden');
  // Auto-save when closing
  saveSettingsFromUI();
}

async function loadSettingsUI() {
  const settings = await window.vroom.getSettings();
  // Server mode
  serverModeRadios.forEach(r => {
    r.checked = r.value === settings.mode;
  });
  selfhostedUrlRow.classList.toggle('hidden', settings.mode !== 'selfhosted');
  selfhostedUrl.value = settings.serverUrl || '';

  // Auth state
  updateAuthUI(settings.auth);
  settingsError.textContent = '';
}

function updateAuthUI(auth) {
  if (auth && auth.email) {
    settingsUser.classList.remove('hidden');
    googleLoginBtn.style.display = 'none';
    settingsUserName.textContent = auth.name || 'User';
    settingsUserEmail.textContent = auth.email;
    if (auth.picture) {
      settingsAvatar.src = auth.picture;
      settingsAvatar.style.display = '';
    } else {
      settingsAvatar.style.display = 'none';
    }
  } else {
    settingsUser.classList.add('hidden');
    googleLoginBtn.style.display = '';
  }
}

async function saveSettingsFromUI() {
  const mode = document.querySelector('input[name="serverMode"]:checked')?.value || 'managed';
  await window.vroom.saveSettings({
    mode,
    serverUrl: selfhostedUrl.value.trim(),
  });
}

settingsBtn.addEventListener('click', showSettings);
settingsClose.addEventListener('click', hideSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) hideSettings();
});

serverModeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    const isSelfHosted = document.querySelector('input[name="serverMode"]:checked')?.value === 'selfhosted';
    selfhostedUrlRow.classList.toggle('hidden', !isSelfHosted);
  });
});

googleLoginBtn.addEventListener('click', async () => {
  // Save credentials first in case they were just entered
  await saveSettingsFromUI();

  settingsError.textContent = '';
  googleLoginBtn.disabled = true;
  googleLoginBtn.textContent = 'Waiting for browser...';

  try {
    const result = await window.vroom.googleLogin();
    if (result.success) {
      updateAuthUI(result.auth);
    } else {
      settingsError.textContent = result.error || 'Login failed';
    }
  } catch (err) {
    settingsError.textContent = err.message || 'Login failed';
  } finally {
    googleLoginBtn.disabled = false;
    googleLoginBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Login with Google';
  }
});

logoutBtn.addEventListener('click', async () => {
  await window.vroom.logout();
  updateAuthUI(null);
});
