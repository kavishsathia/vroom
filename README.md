<p align="center">
  <img src="assets/logo.png" alt="Vroom" width="384" />
</p>

<h1 align="center">Vroom · Virtual Room</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-Extension_MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/Gemini-Live_API-8E75B2?logo=googlegemini&logoColor=white" alt="Gemini" />
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
</p>

View full human-written writeup here: [kavishsathia.com/writing/browser-agents](https://kavishsathia.com/writing/browser-agents)

Browser agents are holding back. What if the problem isn't the model, but the architecture?

## The Problem

Current browser agents are monolithic. One agent screenshots the page, clicks buttons, types text, and tries to follow your instructions — all at once. Context gets diluted. Instructions get forgotten. You end up babysitting.

The deeper issue: the agent is handling **intent** and **execution** simultaneously. It's like a coding agent that only has bash commands — it spends all its energy on implementation details and loses sight of what you actually asked for.

## The Architecture

Vroom separates intent from execution.

```
Task → Expressor → Executor → Browser
                ↑               |
                └── Summary ────┘
```

**Expressor** — receives a task, watches the browser in real-time (video + audio), and issues high-level intentions: _"click the Add Skill button"_, _"type Python in the search field"_. It never touches the DOM directly. It's pure intent.

**Executor** — receives a single UI instruction, takes a screenshot, identifies the target element via bounding box detection, and performs the click/type/scroll. It's pure execution.

The expressor doesn't need to know how buttons get clicked. The executor doesn't need to know why.

## The Bigger Picture

The full vision has more moving parts:

- **Extractor** — breaks a big task into independent subtasks and delegates to multiple expressors
- **Multiple Expressors** — each gets its own tab, running in parallel
- **Floor** — agents speak one at a time through a shared queue, so they can coordinate
- **Preemptive Multiplexer** — the human can step in mid-conversation and steer all agents at once, like a veto

Think of it as a Zoom meeting of AI agents. You get an eagle's eye view of all tabs at once, agents talk to each other through audio, and you can preempt anytime through voice.

## Phase 1: What's Here Now

A single Expressor + Executor as a Chrome extension and Python server.

- **Gemini Live API** streams audio + video in real-time to the expressor
- **Gemini 3 Flash** handles vision-based UI element detection for the executor
- **Chrome DevTools Protocol** dispatches trusted click events
- You talk to the agent, it talks back, and it operates the browser

### Structure

```
extension/          Chrome extension (MV3)
  background.js     Service worker, WebSocket, CDP clicks, frame capture
  content.js        Type and scroll actions via content script
  sidepanel.*       UI for text tasks and status
  mic.*             Popup window for mic capture (16kHz PCM)

server/             Python backend
  main.py           WebSocket server
  expressor.py      Gemini Live API session with tool calls
  executor.py       Screenshot → bounding box → action loop
```

### Running

```bash
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Add your `GOOGLE_API_KEY` to `server/.env`, then:

```bash
python main.py
```

Load `extension/` as an unpacked Chrome extension. Click the Vroom icon to open the side panel. Start talking.
