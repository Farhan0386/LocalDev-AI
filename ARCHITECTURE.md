# LocalDev AI — System Architecture

**Status:** Complete — Phases 1–7 plus reliability, UI, model management, and dGPU hardening. Windows and Ubuntu 26.10 live Ollama workflows are validated; macOS remains unvalidated.

## 1. High-Level Design

```text
VS Code Extension Host (TypeScript)
  ├── extension.ts            — Activation, commands, config sync, lifecycle
  ├── chatViewProvider.ts     — Copilot-style sidebar webview, History & Model Managers,
  │                             dGPU toggle, streaming, safe insertion & CRUD approval cards
  ├── workspaceContext.ts     — Active editor, @file fuzzy resolution, @workspace tree, budgeting
  ├── inlineCompletion.ts     — Debounced FIM Tab autocomplete provider
  ├── diffUtils.ts            — Strict unified-diff parser & patch applier
  ├── tracebackParser.ts      — Python stack-trace parser
  └── pythonEngine.ts         — Python 3.12+ discovery, venv, JSONL child-process transport
            │
            │  JSONL v1 over stdin / stdout (<= 64 KiB per line)
            ▼
Python 3.12+ Local Engine (localdev_ai_engine)
  ├── __main__.py             — Stdin/stdout router, schema & 64-KiB checks, preemption, worker thread
  ├── ollama.py               — Stdlib HTTP client, streaming chat, context budgeting, dGPU/num_ctx,
  │                             pull_model, copy_model, delete_model, FIM inline_complete, stats
  ├── hardware.py             — CPU/RAM/NVIDIA VRAM detection, fit estimates, MODEL_CATALOG tiers
  ├── status.py               — Engine health status
  └── scripts/benchmark.py    — Dependency-free latency, TTFT, RSS, and privacy baseline runner
            │
            ├───────────────────────────┐
            ▼                           ▼
   Local Ollama HTTP API       OS / Hardware Probes
  (http://127.0.0.1:11434)     (/proc/meminfo, GlobalMemoryStatusEx,
   /api/version, /api/tags,     os.sysconf, nvidia-smi)
   /api/chat, /api/generate,
   /api/pull, /api/copy,
   /api/delete
```

## 2. Component Responsibilities

### VS Code Extension (`extension/src/`)
- **Lifecycle & Commands (`extension.ts`):** Starts `PythonEngine` using the staged `engine/src` folder and an isolated `venv` under `globalStorageUri`. Registers all 11 palette/view commands and synchronizes `localdev-ai.*` configuration changes with the sidebar.
- **Copilot-Style Sidebar (`chatViewProvider.ts`):** Hosts `localdev-ai.chatView` (`retainContextWhenHidden: true`), tracks `_lastActiveEditor` so code insertion works even after sidebar clicks, manages up to 30 per-workspace sessions in `workspaceState`, renders Model Manager and History drawers, enforces payload budgeting (`_fitPayloadToJsonlLimit`), and executes file writes/deletions only upon explicit user click on approval cards (`create`, `update`, `delete`) while allowing up to 2 bounded automatic `read` observation hops.
- **Workspace Context (`workspaceContext.ts`):** Extracts the active selection (or top 80 lines) for `file` documents, builds a directory outline excluding build/cache directories (`DEFAULT_EXCLUDE_GLOB`), resolves `@filename` mentions from user prompts (skipping bare Python decorators like `@property`), and enforces a total character budget (`1500`–`12000` chars).
- **Inline Completion (`inlineCompletion.ts`):** Provides debounced (`500ms`) Fill-In-the-Middle completions using 35 prefix lines and 20 suffix lines, forwarding `use_gpu` and `num_gpu` preferences.
- **Diff & Traceback Utilities (`diffUtils.ts`, `tracebackParser.ts`):** Parses Python tracebacks and applies unified diffs (supporting optional markdown fences and `diff --git` / `index` headers) with strict context-line verification.
- **Engine Transport (`pythonEngine.ts`):** Discovers Python 3.12+ (`py -3`, `python`, `python3`), creates/validates `venv`, enforces the 20-second `ready` handshake, prevents >64 KiB writes, validates strictly sequential `token` events (`sequence: 1..N`), handles unkeyed single-pending error frames cleanly, and runs graceful/bounded shutdown.

### Python Engine (`engine/src/localdev_ai_engine/`)
- **Protocol Loop & Concurrency (`__main__.py`):** Reads JSONL requests from `stdin`, sniffs `request_id` even when lines exceed `MAX_JSONL_MESSAGE_BYTES` (64 KiB) so clients receive correlated `REQUEST_TOO_LARGE` errors, validates request schemas, runs inference on a daemon worker `Thread`, processes `cancel` control messages immediately on the main loop, and injects `execution_mode`, `ram_available_bytes`, and `vram_free_bytes` into `chat_session` stats.
- **Ollama Client (`ollama.py`):** Uses Python standard library `urllib.request` with zero external runtime dependencies. Handles readiness, model CRUD (`pull_model`, `copy_model`, `delete_model`), streaming chat (`chat_session_stream`, `explain_code_stream`), single-shot tasks (`explain_traceback`, `propose_patch`, `inline_complete`), watchdog timeouts, and throughput/TTFT telemetry.
- **Hardware Intelligence (`hardware.py`):** Probes CPU cores/architecture, system memory, and optional NVIDIA GPU/VRAM (`nvidia-smi`), estimates per-model fit (`Comfortable`, `Tight`, `Too Large`, `Unknown`), and serves the 19-model `MODEL_CATALOG` across `ultra_light`, `standard`, and `performance` tiers.

## 3. Extension ↔ Engine Transport & Concurrency

- **Transport:** Long-lived child process communicating via UTF-8 JSONL over `stdin`/`stdout` (`protocol_version: "1"`). `stdout` is strictly reserved for JSONL protocol messages; diagnostic logs go to `stderr`.
- **Single-Worker Inference & Preemption:** Only one inference thread runs at a time. If a second non-inline inference request arrives while one is running, the engine rejects it immediately with retryable `BUSY`. However, if background `inline_complete` is running when a user-initiated `chat_session` or `pull_model` arrives, `__main__.py` cancels and preempts the stale `inline_complete` worker cleanly.
- **Cancellation:** `cancel` messages set `active.cancel_event` and close the open HTTP response socket; the worker suppresses late tokens and emits a single `REQUEST_CANCELLED` terminal error.

## 4. Context Window Budgeting & Timeout Isolation

Multi-turn reliability relies on three coordinated guards:
1. **Extension History & JSONL Guard:** `ChatViewProvider` selects at most `maxHistoryTurns` (default `8`) valid non-error messages, caps individual older messages (`2400` chars), bounds `workspaceContext` (`workspaceContext.ts`), and runs `_fitPayloadToJsonlLimit()` so the serialized JSONL request never exceeds `52 KiB` (safely under the `64 KiB` engine limit).
2. **Engine `num_ctx` Budgeting:** `ollama.py` resolves `num_ctx` (explicit setting `localdev-ai.numCtx`, or hardware tier default `2048` / `4096` / `8192`) and passes `options.num_ctx` to `/api/chat`. `_budget_chat_messages()` keeps the system prompt (trimmed to <=55% of budget) plus as many recent turns as fit within `~2.8 * num_ctx` characters, inserting a compact omission note if older turns are dropped.
3. **Separated Timeouts:** Metadata checks (`/api/version`, `/api/tags`, `/api/copy`, `/api/delete`) use `ollamaTimeoutSeconds` (`5s`). Streaming `/api/chat` uses `inferenceTimeoutSeconds` (`120s`, with socket timeout `>= first_token_timeout_seconds`) so multi-turn prompt evaluation never times out at 5 seconds; `pull_model` uses `>= 600s`. Watchdog threads enforce `first_token_timeout_seconds` (`120s`), `inactivity_timeout_seconds` (`120s`), and `max_request_duration_seconds` (`600s`).

## 5. dGPU / CPU Offload Control

- `localdev-ai.useGpu` (boolean, default `true`) and `localdev-ai.numGpuLayers` (`-1` default) are toggled directly from the sidebar `dGPU: ON/OFF` pill or `localdev-ai.toggleGpu`.
- `_build_inference_options()` translates these to Ollama's `options.num_gpu`:
  - `use_gpu = False` -> `"num_gpu": 0` (forces 100% CPU/RAM execution).
  - `use_gpu = True` -> `"num_gpu": num_gpu` if `>= 0`, else `"num_gpu": -1` (Ollama automatic GPU layer offload).
- Reported back in `stats.execution_mode` (`"GPU"` or `"CPU"`).

## 6. Code Insertion & Patch Safety

- **Code Block Insert:** Resolving a valid `TextEditor` (active -> visible -> `_lastActiveEditor` -> first attached `@file` -> untitled buffer), focusing it via `showTextDocument`, checking `editor.edit(...)` success, moving selection, and calling `revealRange`.
- **CRUD Approval Cards:** `create`, `update`, and `delete` actions always require clicking **Approve / Apply**. Updates read the live open `TextDocument` buffer when available, verify unified diffs via `applyUnifiedDiff` without guessing mismatched hunks, apply edits via `vscode.WorkspaceEdit`, and save cleanly. Workspace root containment is verified with `path.relative`.

## 7. Security, Privacy & Packaging

- **Privacy:** Local inference defaults to `http://127.0.0.1:11434`. Network access only occurs when the user explicitly triggers `pull_model` or opens external links. Source code is not persisted to an external database or sent to cloud LLM APIs.
- **VSIX Packaging:** `extension/scripts/stage-engine.js` copies only `engine/src` into `extension/engine/src`, and `extension/.vscodeignore` excludes tests, source maps, `src/`, `scripts/`, `node_modules/`, and `__pycache__/`.
- **Platform Status:** Windows and Ubuntu 26.10 live Ollama workflows are validated; macOS remains unvalidated.
