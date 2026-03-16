<p align="center">
  <img src="assets/logo.png" alt="Vroom" width="384" />
</p>

<h1 align="center">Vroom</h1>

<p align="center">
  <strong>Multi-agent browser automation with parallel execution, contracts, and voice</strong>
</p>

<p align="center">
  <a href="https://github.com/kavishsathia/vroom/actions/workflows/ci.yml"><img src="https://github.com/kavishsathia/vroom/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/Gemini-Flash_&_Live_API-8E75B2?logo=googlegemini&logoColor=white" alt="Gemini" />
  <img src="https://img.shields.io/badge/Terraform-GCP-7B42BC?logo=terraform&logoColor=white" alt="Terraform" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License" /></a>
</p>

<p align="center">
  <a href="https://kavishsathia.com/writing/browser-agents">Full writeup</a>
</p>

---

## Why

Browser agents today are monolithic. One agent screenshots, clicks, types, and follows instructions — all at once. Context gets diluted. Instructions get forgotten. You end up babysitting.

The deeper issue: the agent handles **intent** and **execution** simultaneously. It's like a coding agent that only has bash — it burns all its energy on implementation details and loses sight of what you actually asked for.

Vroom separates intent from execution, then parallelizes it.

## Architecture

```mermaid
graph TD
    subgraph Electron["Electron Desktop"]
        T1["Tab 1 (webview)"]
        T2["Tab 2 (webview)"]
        T3["Tab 3 (webview)"]
    end

    Electron -- "WebSocket" --> Server

    subgraph Server["Python Server"]
        EX["Extractor — Decomposes task · Spawns executors · Reviews contracts"]
        EX --> A1["Agent A (Alice) — Tab 1"]
        EX --> A2["Agent B (Bob) — Tab 2"]
        EX --> A3["Agent C (Carol) — Tab 3"]
        A1 & A2 & A3 --> MUX["Multiplexer — Shared audio · Voice pool · Preemption"]
        A1 & A2 & A3 --> CO["Contracts — Per-agent commitments"]
        A1 & A2 & A3 --> SK["Skills — Per-user knowledge base"]
    end

    Server --> DB[("PostgreSQL\n(Cloud SQL)")]
```

### Core components

| Component | Role |
|---|---|
| **Extractor** | Receives a task, decomposes it into independent subtasks, spawns parallel executors, reviews results via contracts, spawns follow-up rounds if needed |
| **Agent** | Controls a single browser tab. Screenshots the page, reasons with Gemini vision, performs UI actions (click, type, scroll, navigate, hover). One agent per tab |
| **Multiplexer** | Manages a shared audio channel across all agents. Round-robin voice assignment (Alice, Bob, Carol...), spotlight-based TTS via Gemini Live API, interruptible sleep, preemption |
| **Contract** | Each agent receives a contract with verifiable commitments. Agents mark commitments done/failed and attach memos for blockers or corrections. The extractor reviews these to decide next steps |
| **Skills** | Per-user persistent knowledge base. Agents can read, create, and update skills — reusable procedures learned during execution (login flows, site quirks, workarounds) |

## Key features

**Parallel multi-agent execution** — The extractor decomposes tasks and spawns multiple agents on separate browser tabs simultaneously. Each agent works independently with its own contract.

**Contract-based accountability** — Every agent gets explicit commitments (e.g., "Navigate to google.com", "Click the first result"). The extractor reviews contract status after execution and spawns follow-up agents for failures.

**Audio preemption** — The user can interrupt all agents mid-task by speaking. The multiplexer pauses the pipeline, cancels active TTS, broadcasts the user's audio to all agents, and resumes. Agents adapt in real-time.

**Visual preemption** — The user can take manual control of any tab. The agent is blocked, the user clicks around, and when control returns the agent receives screenshots of what the user did and continues from the new page state.

**Shared voice channel** — Agents speak to the user through a single audio channel using distinct Gemini Live API voices. Spotlight-based: only one agent speaks at a time, others queue.

**Skill learning** — Agents build a persistent per-user skill library. If an agent discovers a reusable procedure, it saves it as a skill. Future agents across sessions can read and apply these skills.

**Tab reattachment** — When an executor fails, the extractor can spawn a new agent on the same tab. The page state is preserved, so the new agent picks up where the old one left off.

## Stack

| Layer | Technology |
|---|---|
| Desktop | Electron 33, embedded webviews with Chrome DevTools Protocol |
| Server | Python 3.12, async/await, WebSocket |
| AI | Gemini Flash (vision + tool use), Gemini Live API (streaming TTS) |
| Database | PostgreSQL via asyncpg |
| Infra | Google Cloud Run, Cloud SQL, Artifact Registry, Terraform |
| CI/CD | GitHub Actions (lint + test), Cloud Build (deploy) |

## Project structure

```
electron/               Electron desktop app
  main.js               Main process — webview management, CDP, OAuth, WebSocket
  renderer.js           Renderer — tab grid, logs, chat, contracts, audio controls
  preload.js            IPC bridge
  index.html            UI layout

server/                 Python backend
  main.py               WebSocket server, auth, session management
  extractor.py          Task decomposition + multi-agent orchestration
  agent.py              Single-tab browser automation via Gemini vision
  multiplexer.py        Shared audio channel, preemption, voice pool
  contract.py           Commitment tracking per executor
  skills.py             Per-user skill store
  db.py                 PostgreSQL schema + queries
  tests/                Unit tests

infra/                  Terraform (GCP)
  main.tf               Cloud Run, Cloud SQL, Artifact Registry, VPC
```

## Getting started

### Prerequisites

- Python 3.12+
- Node.js 18+
- PostgreSQL (local or Cloud SQL)
- [Google AI API key](https://aistudio.google.com/apikey)

### Server

```bash
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create `server/.env`:

```env
GOOGLE_API_KEY=your_api_key
DATABASE_URL=postgresql://localhost/vroom
```

```bash
python main.py
```

### Electron app

```bash
cd electron
npm install
```

Create `electron/.env`:

```env
VROOM_SERVER_URL=ws://localhost:8765
```

```bash
npm start
```

### Tests

```bash
cd server
pip install pytest pytest-asyncio
pytest tests/ -v
```

## Infrastructure

The server is deployed to Google Cloud Run with Terraform:

```bash
cd infra
terraform init
terraform apply -var="project_id=your-project" -var="db_password=..." -var="google_api_key=..."
```

Cloud Build handles CI/CD — pushes to `main` build and deploy automatically via `cloudbuild.yaml`.

## How it works

1. User submits a task via the Electron app (text or voice)
2. **Extractor** analyzes the task, breaks it into independent subtasks, and attaches relevant skills
3. **Agents** spawn on separate browser tabs, each with a contract of specific commitments
4. Agents screenshot the page, reason with Gemini Flash, and perform UI actions
5. Agents speak to the user through the **Multiplexer** (shared audio, distinct voices)
6. User can **preempt** anytime — audio interrupts all agents, visual preemption takes control of a specific tab
7. When agents finish, the Extractor reviews contracts and spawns follow-up agents if needed
8. Final summary is delivered when all commitments are resolved

## License

[MIT](LICENSE)
