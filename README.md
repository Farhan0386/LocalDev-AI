# LocalDev AI

A local-first, privacy-preserving, hardware-adaptive AI coding assistant for Visual Studio Code powered by a lightweight Python 3.12+ engine and local [Ollama](https://ollama.com) models.

---

## Table of Contents

1. [Project Overview & Philosophy](#project-overview--philosophy)
2. [How It Works (Two-Process Architecture)](#how-it-works-two-process-architecture)
3. [Complete Codebase Structure](#complete-codebase-structure)
4. [Component-by-Component Breakdown](#component-by-component-breakdown)
5. [Installation & Build Guide](#installation--build-guide)
6. [Quick-Start Usage Guide](#quick-start-usage-guide)
7. [Configuration & Command Reference](#configuration--command-reference)
8. [Testing, Benchmarking & Verification](#testing-benchmarking--verification)
9. [Project Documentation Index](#project-documentation-index)
10. [Privacy, Safety & Known Limitations](#privacy-safety--known-limitations)

---

## Project Overview & Philosophy

LocalDev AI brings interactive chat, code explanations, Python traceback debugging, minimal unified-diff patch proposals, and Fill-In-the-Middle (FIM) `Tab` autocomplete directly inside VS Code without paid cloud AI APIs or mandatory accounts.

Core design principles:
- **Local-First & Zero Cloud APIs:** All inference runs against your local Ollama endpoint (default `http://127.0.0.1:11434`). Source code and prompts are never transmitted to external cloud LLM APIs.
- **Zero Silent File Writes:** In `Edit` mode, proposed file creations, updates, unified diffs, and deletions render as interactive approval cards requiring an explicit **Approve / Apply** click before touching the workspace. Generated code is never executed automatically.
- **Hardware-Adaptive & Resource-Conscious:** Probes system CPU, RAM, and NVIDIA GPU VRAM (`nvidia-smi` when available), estimates per-model fit (`Comfortable`, `Tight`, `Too Large`, `Unknown`), adapts `num_ctx` and context budgets to your tier, lets you toggle **dGPU: ON/OFF** (`num_gpu` auto vs `0` CPU-only), and keeps runtime dependencies minimal (Python standard library only in the engine).
- **Learning-First:** Supports `Ask` mode, optional `hintOnly` guiding prompts, and `Explain` / `Traceback` commands tailored for understanding why a fix works.

---

## How It Works (Two-Process Architecture)

LocalDev AI separates VS Code editor/UI integration from local model orchestration using a long-lived child-process IPC boundary:

```text
┌──────────────────────────────────────────────────────────┐
│ VS Code Extension Host (TypeScript)                      │
│  • Copilot-style Webview Sidebar (localdev-ai.chatView)  │
│  • Inline Tab Autocomplete (FIM) & Editor Commands       │
│  • Workspace Context Collector & Budgeter                │
│  • Explicit Code Insertion & WorkspaceEdit Patch Apply   │
└───────────────────────────┬──────────────────────────────┘
                            │  JSONL over stdin / stdout
                            │  (Protocol v1, 64 KiB max line)
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Python 3.12+ Local Engine (localdev_ai_engine)           │
│  • Strict JSONL Schema & 64-KiB Guard (__main__.py)      │
│  • Worker Thread Inference + Cooperative Cancel          │
│  • Context Budgeting, dGPU/num_ctx Options (ollama.py)   │
│  • CPU/RAM/VRAM Probes & Curated Catalog (hardware.py)   │
└───────────────────────────┬──────────────────────────────┘
                            │  HTTP/JSON (loopback only)
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Local Ollama Server (http://127.0.0.1:11434)             │
│  • /api/version, /api/tags, /api/chat, /api/generate     │
│  • /api/pull, /api/copy, /api/delete                     │
└──────────────────────────────────────────────────────────┘
```

1. **Startup & Isolation:** On activation, `PythonEngine` discovers a compatible Python 3.12+ interpreter, creates or validates an isolated virtual environment under VS Code `globalStorageUri`, spawns `python -m localdev_ai_engine`, and waits up to 20 seconds for `{"protocol_version":"1","type":"event","event":"ready"}`.
2. **Bounded Request/Stream Loop:** The extension serializes requests as single-line JSONL (`<= 64 KiB`). The Python engine validates every field, runs inference in a background worker thread while keeping `stdin` free for `cancel` control messages, streams ordered `token` events (`sequence: 1..N`), and finishes with exactly one terminal `response` (including `tok/s`, `TTFT`, `RAM`, and `GPU`/`CPU` execution stats) or structured `error`.
3. **Zero Unhandled Hangs:** Multi-turn chat budgets both workspace context and history relative to `num_ctx` and the 64-KiB IPC ceiling, separates fast metadata checks (`ollamaTimeoutSeconds`, default `5s`) from streaming inference (`inferenceTimeoutSeconds`, default `120s`), and rejects unkeyed or oversized errors cleanly so the UI never locks up.

---

## Complete Codebase Structure

```text
LocalDev-AI/
├── extension/                                # TypeScript VS Code extension & VSIX packaging
│   ├── src/
│   │   ├── extension.ts                      # Activation, engine lifecycle, commands, config watcher
│   │   ├── chatViewProvider.ts               # Copilot-style sidebar WebviewViewProvider, drawers, CRUD & insertion
│   │   ├── pythonEngine.ts                   # Python 3.12+ discovery, venv setup, JSONL child-process transport
│   │   ├── workspaceContext.ts               # Active editor snippet, @file fuzzy resolution, @workspace tree, budgeting
│   │   ├── inlineCompletion.ts               # Debounced Fill-In-the-Middle (FIM) Tab autocomplete provider
│   │   ├── diffUtils.ts                      # Strict unified-diff hunk parser & safe patch applier
│   │   └── tracebackParser.ts                # Python stack-trace parser (frames, exception type/message)
│   ├── tests/
│   │   ├── pythonEngine.test.js              # Node tests for Python discovery, lifecycle, streaming, cancel, 64-KB limits
│   │   └── diffUtils.test.js                 # Node tests for unified diff application, git headers, mismatch rejection
│   ├── scripts/
│   │   └── stage-engine.js                   # Copies engine/src into extension/engine/src before vsce package
│   ├── media/
│   │   └── icon.svg                          # Activity Bar vector icon for LocalDev AI
│   ├── package.json                          # Extension manifest, commands, views, settings, npm scripts
│   ├── tsconfig.json                         # TypeScript compiler config (ES2022 -> out/)
│   ├── .vscodeignore                         # Excludes src/, tests/, scripts/, maps, and dev artifacts from VSIX
│   └── README.md                             # Packaged extension summary
├── engine/                                   # Dependency-free Python 3.12+ local engine
│   ├── src/localdev_ai_engine/
│   │   ├── __init__.py                       # Exposes package health_status()
│   │   ├── __main__.py                       # JSONL stdin/stdout router, schema & 64-KB checks, worker dispatch
│   │   ├── ollama.py                         # HTTP client for Ollama APIs, streaming, budgeting, dGPU/num_ctx, pull/copy/delete
│   │   ├── hardware.py                       # CPU/RAM/GPU probes, fit estimator, multi-tier MODEL_CATALOG recommendations
│   │   └── status.py                         # Engine version & health payload helper
│   ├── tests/
│   │   ├── test_engine.py                    # Package import and health_status tests
│   │   ├── test_ollama.py                    # Reachability, timeouts, model metadata, and selection tests
│   │   ├── test_explain.py                   # Streaming/non-streaming explain, error normalization, cancel, watchdog timeouts
│   │   ├── test_protocol.py                  # JSONL framing, request_id correlation, BUSY, cancel, 64-KB rejection tests
│   │   └── test_chat.py                      # Multi-turn chat budgeting, dGPU/num_ctx, pull_model errors, catalog, FIM, stats
│   ├── scripts/
│   │   └── benchmark.py                      # Dependency-free 4-case latency, TTFT, RSS, and privacy benchmark
│   └── pyproject.toml                        # Python >=3.12 package metadata & pytest config
├── ADR-001-EXTENSION-ENGINE-COMMUNICATION.md # Transport & lifecycle Architecture Decision Record
├── ARCHITECTURE.md                           # System architecture, concurrency, budgeting, and security boundaries
├── API_INTEGRATION.md                        # Complete JSONL v1 protocol & Ollama HTTP API specification
├── DESIGN.md                                 # UX, sidebar layout, interaction states, and accessibility design
├── DATABASE.md                               # Persistence decision (workspaceState sessions; no database required)
├── IMPLEMENTATION_PLAN.md                    # Phase-by-phase delivery checklist and verification commands
├── PRD.md                                    # Product requirements, goals, and non-goals
├── PROJECT_PROGRESS.md                       # Living implementation log, test counts, and sign-off status
├── TESTING.md                                # Test layers, quality matrix, benchmark baseline, release checklist
└── README.md                                 # This guide
```

---

## Component-by-Component Breakdown

### Extension (`extension/src/`)

- **`extension.ts`** — Entry point (`activate` / `deactivate`). Instantiates and starts `PythonEngine` using the packaged `engine/src` path and `globalStorageUri/venv`, registers all 11 VS Code commands (`openChat`, `newChat`, `refreshModels`, `checkHardware`, `selectModel`, `explainCode`, `explainTraceback`, `proposePatch`, `toggleAutocomplete`, `toggleGpu`, `helloWorld`), wires `LocalDevInlineCompletionProvider` and `ChatViewProvider`, and listens to configuration changes to keep the sidebar synchronized.
- **`chatViewProvider.ts`** — Implements the Copilot-style sidebar (`WebviewViewProvider` `localdev-ai.chatView`). Manages:
  - **Compact Header & Drawers:** Active session title, Ollama online/offline indicator + Start/Stop server control, `+` New Chat, History drawer (switch, rename via `showInputBox`, delete via modal confirmation, clear), Model Manager drawer (custom tag pull with cancel, installed models list with Use/Copy/Delete, and hardware-tiered catalog), `dGPU: ON/OFF` toggle, and `Tab: ON/OFF` autocomplete toggle.
  - **Reliable Code Insertion & CRUD Cards:** Tracks `_lastActiveEditor` so clicking **Insert** in the webview resolves the active, visible, last-active, or attached editor (or opens an untitled editor), awaits `editor.edit(...)`, and reveals the inserted range. Stores raw code blocks in `codeBlockStore` prior to HTML escaping so code is never corrupted. Parses `localdev_tool` JSON and `diff` blocks into approval cards (`create`, `update`, `delete`, `read`), auto-executes up to 2 bounded `read` observation hops, and applies approved edits via `vscode.WorkspaceEdit` + `doc.save()`.
  - **Multi-Turn Budgeting & Session Persistence:** Caps history via `maxHistoryTurns`, fits serialized payloads safely below the 64-KiB JSONL limit (`_fitPayloadToJsonlLimit`), skips empty/error turns, and persists up to 30 recent per-workspace sessions in `workspaceState`.
- **`pythonEngine.ts`** — Manages Python 3.12+ discovery (`py -3`, `python`, `python3`), isolated `venv` creation/validation, child process spawn/startup handshake (`20s` timeout), ordered `token` event sequence verification, `cancel` control messages, client-side 64-KiB guard, unkeyed error rejection (preventing hangs), and graceful shutdown.
- **`workspaceContext.ts`** — Collects active editor selection (or top 80-line snippet) for `file` URIs, builds a bounded directory tree (`DEFAULT_EXCLUDE_GLOB` excluding `.git`, `node_modules`, `.venv`, `__pycache__`, `out`, `dist`, `.vscode`, `.idea`, `*.pyc`, `*.vsix`), fuzzy-resolves `@filename` mentions from user prompts (skipping bare Python decorators such as `@property`), provides `@file` search results, and enforces a strict total character budget across all context sections.
- **`inlineCompletion.ts`** — Registers `InlineCompletionItemProvider` (`pattern: '**'`). Debounces typing (`500ms`), cancels stale in-flight requests, captures up to 35 lines of prefix and 20 lines of suffix, respects `useGpu` / `numGpuLayers`, and requests FIM completion via `inline_complete`.
- **`diffUtils.ts` & `tracebackParser.ts`** — `diffUtils.ts` strips optional markdown fences and `diff --git` / `index` headers, validates unified diff hunks line-by-line, and returns `undefined` on any context mismatch rather than corrupting files. `tracebackParser.ts` extracts `File "...", line N, in ...` frames and exception types/messages for `explainTraceback` and `proposePatch`.

### Python Engine (`engine/src/localdev_ai_engine/`)

- **`__main__.py`** — Runs the long-lived `stdin`/`stdout` JSONL protocol v1 loop. Enforces `MAX_JSONL_MESSAGE_BYTES` (64 KiB) while sniffing `request_id` on oversized lines so clients never hang, validates every request/cancel message, dispatches inference tasks on a background `Thread`, allows user-initiated tasks (`chat_session`, `pull_model`) to preempt background `inline_complete`, and attaches `execution_mode`, `ram_available_bytes`, and `vram_free_bytes` telemetry to `chat_session` responses.
- **`ollama.py`** — Dependency-free `urllib.request` client for local Ollama (`http://127.0.0.1:11434`). Implements `version`, `models`, `readiness`, `explain_code`, `explain_code_stream`, `explain_traceback`, `propose_patch`, `chat_session_stream` (with `_budget_chat_messages`), `pull_model` (progress formatting, `error` chunk detection, `success` verification), `copy_model`, `delete_model`, and FIM `inline_complete`. Configures `options.num_gpu` (`-1` or configured layers when `use_gpu=True`; `0` when `use_gpu=False`) and `options.num_ctx`, separates socket timeouts for streaming (`>= first_token_timeout_seconds`, `>= 600s` for pulls), runs a watchdog thread for first-token/inactivity/max-duration timeouts, and computes `tokens_per_second` and `ttft_ms`.
- **`hardware.py`** — Probes CPU cores/architecture (`os.cpu_count`, `platform`), system RAM (`/proc/meminfo`, Windows `GlobalMemoryStatusEx`, `os.sysconf`), and NVIDIA GPU/VRAM (`nvidia-smi`). Implements `estimate_model_fit` (`Comfortable`, `Tight`, `Too Large`, `Unknown`), `get_hardware_tiers`, and `recommend_model` backed by a 19-model multi-tier `MODEL_CATALOG` spanning `qwen2.5-coder`, `qwen3`, `llama3.2`, `llama3.1`, `gemma3`, `deepseek-r1`, `phi4-mini`, `starcoder2`, and `codellama`.
- **`status.py`** — Returns the foundation health payload (`service: "localdev-ai-engine"`, `status: "ok"`, `version: "0.1.0"`).

---

## Installation & Build Guide

### Prerequisites

- **VS Code:** `1.146.0` or newer (as declared in `extension/package.json`)
- **Python:** `3.12` or newer on `PATH` (or `py -3` on Windows)
- **Ollama:** Installed locally ([ollama.com](https://ollama.com))
- **Node.js & npm:** Required only when building, testing, or packaging from source (recommended Node.js 20+/24 LTS)

### Option A: Install from Pre-Built `.vsix`

1. **Via Command Line:**
   ```powershell
   code --install-extension extension/localdev-ai-0.0.1.vsix --force
   ```
2. **Via VS Code UI:**
   - Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
   - Click the `...` (**Views and More Actions**) menu -> **Install from VSIX...**.
   - Select `extension/localdev-ai-0.0.1.vsix` and reload VS Code if prompted.

### Option B: Build, Test & Package from Source

1. **Install Extension Dependencies & Compile:**
   ```powershell
   cd extension
   npm install
   npm run compile
   ```
2. **Run Extension Unit Tests (13 Node tests):**
   ```powershell
   npm test
   ```
3. **Package the `.vsix` (stages `engine/src` automatically):**
   ```powershell
   npm run package
   ```
   This outputs `extension/localdev-ai-0.0.1.vsix`.
4. **Set Up Python Dev Environment & Run Engine Tests (40 pytest tests):**
   From the repository root:
   ```powershell
   python -m venv .venv
   .venv\Scripts\Activate.ps1
   python -m pip install --editable "engine[test]"
   python -m pytest engine/tests -v
   ```
   *(On Linux/macOS: `source .venv/bin/activate`, or run directly with `PYTHONPATH=engine/src pytest engine/tests`.)*

---

## Quick-Start Usage Guide

1. **Open the Sidebar:** Click the **LocalDev AI** icon in the VS Code Activity Bar (or run `LocalDev AI: Open Interactive Chat`).
2. **First-Run Onboarding:**
   - If Ollama is stopped, click **Start Ollama** (launches `ollama serve` in an integrated terminal) or **Install**.
   - If no models are installed, pick one of the hardware-matched starter models directly from the onboarding card, or click **Browse All** / **Models** to pull any model from the curated catalog or a custom Ollama tag (e.g., `qwen3:4b`, `llama3.2:3b`, `gemma3:4b`, `deepseek-r1:7b`).
3. **Toggle Dedicated GPU vs CPU (`dGPU: ON / OFF`):**
   - Click the `dGPU: ON` pill in the header (or run `LocalDev AI: Toggle dGPU Offload`).
   - **ON:** Lets Ollama offload model layers to your GPU (`num_gpu: -1` or your configured `numGpuLayers`).
   - **OFF:** Forces CPU-only inference (`num_gpu: 0`), keeping VRAM free for other tasks.
4. **Manage Models (`Models` Drawer):**
   - Pull any custom tag with live progress and a **Cancel** button.
   - Switch active models, **Copy** (duplicate) a local model, or **Delete** an installed model (with modal confirmation).
5. **Chat with Context (`@file` & `@workspace`):**
   - Your active editor selection (or top lines) is attached automatically.
   - Click `+ @file` or type `@` in the composer to search and attach workspace files.
   - Toggle `+ @workspace` to include a bounded project file tree.
   - Use **History** to switch, rename, or delete saved per-workspace chat sessions, or click `+` to start a new chat.
6. **`Ask` vs `Edit` Mode & Code Insertion:**
   - **Ask mode:** Explanations, debugging, and conceptual guidance. Click **Copy** or **Insert** on any code block to insert it cleanly at your editor cursor.
   - **Edit mode:** Model proposes `create`, `update` (unified diff or full content), `delete`, or `read` actions. `read` actions safely gather bounded file observations (up to 2 hops); write/delete actions render an approval card with diff preview and require clicking **✓ Approve / Apply**.
7. **Tab Autocomplete:** Toggle inline ghost-text FIM completions from the `Tab: ON/OFF` header pill or `LocalDev AI: Toggle Tab Autocomplete`.

---

## Configuration & Command Reference

### Settings (`localdev-ai.*`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `localdev-ai.ollamaEndpoint` | `string` | `"http://127.0.0.1:11434"` | Local Ollama server base URL (`http://` or `https://`). |
| `localdev-ai.ollamaTimeoutSeconds` | `number` | `5` | Connection timeout (seconds) for readiness and model metadata checks (`min: 0.1`). |
| `localdev-ai.inferenceTimeoutSeconds` | `number` | `120` | Streaming inference timeout (seconds) for chat responses (`min: 10`). |
| `localdev-ai.selectedModel` | `string` | `""` | Active installed Ollama model tag used for chat and completions. |
| `localdev-ai.useGpu` | `boolean` | `true` | Enable dGPU layer offloading (`true` = auto/configured layers; `false` = `num_gpu: 0` CPU-only). |
| `localdev-ai.numGpuLayers` | `number` | `-1` | Explicit GPU layer count when `useGpu` is `true` (`-1` = Ollama automatic). |
| `localdev-ai.numCtx` | `number` | `0` | Context window token limit passed to Ollama (`0` = hardware-tier automatic: `2048` / `4096` / `8192`). |
| `localdev-ai.maxHistoryTurns` | `number` | `8` | Maximum recent chat messages retained per turn (`2`–`30`). |
| `localdev-ai.hintOnly` | `boolean` | `false` | Prompt `explainCode`, `explainTraceback`, and `proposePatch` to give hints before full solutions. |
| `localdev-ai.maxRenderedMessages` | `number` | `100` | Maximum chat messages rendered in the sidebar DOM (`20`–`200`). |

### Commands

| Command ID | Palette Title | Purpose |
|---|---|---|
| `localdev-ai.openChat` | `LocalDev AI: Open Interactive Chat` | Focus the sidebar chat view. |
| `localdev-ai.newChat` | `LocalDev AI: New Chat Session` | Focus the sidebar and start a fresh chat session. |
| `localdev-ai.refreshModels` | `LocalDev AI: Refresh Ollama Models` | Query installed Ollama models and verify selection. |
| `localdev-ai.selectModel` | `LocalDev AI: Select Ollama Model` | Pick an installed model via QuickPick. |
| `localdev-ai.checkHardware` | `LocalDev AI: Check Hardware and Model Fit` | Print CPU/RAM/GPU diagnostics and fit estimates to OutputChannel. |
| `localdev-ai.explainCode` | `LocalDev AI: Explain Selected Python Code` | Stream an explanation for the active Python selection. |
| `localdev-ai.explainTraceback` | `LocalDev AI: Explain Python Traceback` | Parse and explain a pasted Python traceback. |
| `localdev-ai.proposePatch` | `LocalDev AI: Propose Minimal Python Patch` | Generate a unified diff for a Python file + traceback with Diff preview & Apply/Reject. |
| `localdev-ai.toggleAutocomplete` | `LocalDev AI: Toggle Tab Autocomplete` | Enable or disable inline FIM ghost-text suggestions. |
| `localdev-ai.toggleGpu` | `LocalDev AI: Toggle dGPU Offload` | Toggle `localdev-ai.useGpu` between GPU offload and CPU-only mode. |
| `localdev-ai.helloWorld` | `LocalDev AI: Hello World` | Smoke-test command from Phase 1 scaffold. |

---

## Testing, Benchmarking & Verification

Run the full verification suite:

```powershell
# 1. Extension TypeScript build, 13 Node unit tests, and VSIX packaging
npm --prefix extension run compile
npm --prefix extension test
npm --prefix extension run package

# 2. Python engine unit & protocol suite (40 pytest tests)
$env:PYTHONPATH = "engine/src"
python -m pytest engine/tests -v

# 3. Live local benchmark (requires running Ollama + installed model)
python engine/scripts/benchmark.py --model qwen3:4b

# 4. Hygiene check
git diff --check
```

---

## Project Documentation Index

- [ARCHITECTURE.md](ARCHITECTURE.md) — Two-process system architecture, concurrency/preemption, context budgeting, and security boundaries.
- [API_INTEGRATION.md](API_INTEGRATION.md) — Complete JSONL v1 protocol schema, all 12 engine tasks, Ollama endpoints, error codes, and telemetry.
- [DESIGN.md](DESIGN.md) — Copilot-style sidebar UX, drawers, interaction states, and accessibility principles.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — Delivery checklist across Phases 1–7 and final polish.
- [TESTING.md](TESTING.md) — Test layers, metrics, benchmark baseline, and release verification checklist.
- [PROJECT_PROGRESS.md](PROJECT_PROGRESS.md) — Detailed engineering progress log and test sign-off records.
- [ADR-001-EXTENSION-ENGINE-COMMUNICATION.md](ADR-001-EXTENSION-ENGINE-COMMUNICATION.md) — Architecture Decision Record for stdio JSONL IPC.
- [PRD.md](PRD.md) — Original product requirements and scope.
- [DATABASE.md](DATABASE.md) — Persistence decision (`workspaceState` sessions; no database required).

---

## Privacy, Safety & Known Limitations

- **Privacy:** Inference runs locally against `localdev-ai.ollamaEndpoint`. Pulling a new model via `pull_model` connects to Ollama's registry over the network when explicitly initiated by the user.
- **Safety:** No generated code is executed automatically. Workspace edits (`create`, `update`, `delete`) require explicit user approval.
- **Platform Support:** Windows and Ubuntu 26.10 live Ollama workflows are validated; **macOS remains unvalidated**.
- **Estimates:** Hardware fit labels (`Comfortable`, `Tight`, `Too Large`) and context tier sizing are conservative heuristics; actual memory usage and latency vary by quantization, context length, and Ollama scheduling.
