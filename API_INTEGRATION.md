# LocalDev AI — API and Integration Contract

**Status:** Implemented (Protocol Version `"1"`). Windows and Ubuntu 26.10 live Ollama workflows are validated; macOS and older Ollama versions remain unvalidated.

## 1. Transport Overview

The VS Code extension manages a long-lived Python 3.12+ child process (`python -m localdev_ai_engine`) communicating over `stdin`/`stdout` using newline-delimited JSON (**JSONL**, UTF-8).

- **`stdout`:** Strictly reserved for JSONL protocol messages (`protocol_version: "1"`).
- **`stderr`:** Reserved for non-protocol diagnostic logs (source code and full prompts are excluded by default).
- **Line Size Limit:** Incoming `stdin` JSONL lines are bounded to `64 KiB` (`65,536` bytes UTF-8). If an oversized line arrives, `__main__.py` sniffs `"request_id"` from the leading bytes so the client receives a correlated `REQUEST_TOO_LARGE` error instead of hanging. `pythonEngine.ts` also checks serialized payloads before writing to `stdin`.

### Lifecycle Handshake

Immediately upon startup, the engine emits:

```json
{"protocol_version":"1","type":"event","event":"ready"}
```

The extension waits up to **20 seconds** (`ENGINE_STARTUP_TIMEOUT_MS`) before marking startup failed.

---

## 2. JSONL Message Envelope

### Request (`type: "request"`)

Allowed top-level keys (`REQUEST_FIELDS` in `__main__.py`):
`protocol_version`, `type`, `request_id`, `task`, `language`, `code`, `question`, `traceback`, `context`, `options`, `messages`, `mode`, `workspace_context`, `model`, `name`, `source`, `destination`, `prefix`, `suffix`, `max_tokens`, `temperature`.

```json
{
  "protocol_version": "1",
  "type": "request",
  "request_id": "request-1732640000000-1",
  "task": "chat_session",
  "options": {
    "ollama_endpoint": "http://127.0.0.1:11434",
    "ollama_timeout_seconds": 120,
    "model": "qwen3:4b",
    "mode": "edit",
    "use_gpu": true,
    "num_gpu": -1,
    "num_ctx": 4096,
    "messages": [{"role": "user", "content": "Explain @app.py"}],
    "workspace_context": {
      "active_file": {"path": "app.py", "language": "python", "content": "...", "line_range": "1-20"},
      "referenced_files": [],
      "directory_tree": "app.py\nutils.py"
    }
  }
}
```

### Streaming Token Event (`type: "event"`, `event: "token"`)

Emitted by `explain_code`, `chat_session`, and `pull_model`:

```json
{
  "protocol_version": "1",
  "type": "event",
  "request_id": "request-1732640000000-1",
  "event": "token",
  "sequence": 1,
  "text": "Here is"
}
```

`sequence` starts at `1` and increments monotonically by `1` per request.

### Terminal Response (`type: "response"`)

```json
{
  "protocol_version": "1",
  "type": "response",
  "request_id": "request-1732640000000-1",
  "status": "ok",
  "task": "chat_session",
  "message": "Complete normalized response text or task object",
  "patch": null,
  "warnings": [],
  "stats": {
    "eval_count": 120,
    "prompt_eval_count": 310,
    "total_tokens": 430,
    "eval_duration_ms": 2400.0,
    "prompt_eval_duration_ms": 180.0,
    "total_duration_ms": 2700.0,
    "tokens_per_second": 50.0,
    "ttft_ms": 240.0,
    "num_gpu": -1,
    "num_ctx": 4096,
    "execution_mode": "GPU",
    "ram_available_bytes": 9663676416,
    "vram_free_bytes": 3800000000,
    "use_gpu": true,
    "gpu_present": true
  }
}
```

*(Note: `stats` is attached on `chat_session` responses.)*

### Terminal Error (`type: "error"`)

```json
{
  "protocol_version": "1",
  "type": "error",
  "request_id": "request-1732640000000-1",
  "code": "OLLAMA_UNAVAILABLE",
  "message": "Ollama is not reachable.",
  "action": "Start Ollama, check the endpoint setting, and retry.",
  "retryable": true
}
```

### Cancellation (`type: "cancel"`)

```json
{
  "protocol_version": "1",
  "type": "cancel",
  "request_id": "request-1732640000000-1"
}
```

Sets `active.cancel_event`, closes the open Ollama HTTP stream, suppresses late tokens, and emits one `REQUEST_CANCELLED` terminal error.

---

## 3. Supported Engine Tasks (`SUPPORTED_TASKS`)

All 12 tasks defined in `engine/src/localdev_ai_engine/__main__.py`:

| Task | Execution | Required / Key Inputs | Output (`response.message`) |
|---|---|---|---|
| `check_setup` | Sync | None | `{ service, status, version }` from `status.health_status()`. |
| `discover_models` | Sync | `options.ollama_endpoint`, `ollama_timeout_seconds` | `{ endpoint, version, models: [...] }` from `/api/version` + `/api/tags`. |
| `select_model` | Sync | `options.model` (+ endpoint/timeout) | Readiness dict with `selected_model` after verifying installation. |
| `hardware_diagnostics` | Sync | `options.ollama_endpoint`, `ollama_timeout_seconds` | `{ hardware, models, guidance, recommendation, tiers, ollama_error? }`. Includes `recommend_model()` (with `alternatives` & `catalog`) and `get_hardware_tiers()` outputs. |
| `copy_model` | Sync | `source`, `destination` | `{ status: "success", source, destination }` via `POST /api/copy`. |
| `delete_model` | Sync | `model` or `name` | `{ status: "success", model }` via `DELETE /api/delete`. |
| `explain_code` | Worker + Stream | `language: "python"`, `code`, optional `question`, `options.model`, `hint_only`, `use_gpu`, `num_gpu`, `num_ctx` | Streams `token` events; terminal `message` has complete explanation text. |
| `explain_traceback` | Worker | `options.model`, `options.traceback` (parsed dict), `hint_only` | Explanation string from `/api/chat`. |
| `propose_patch` | Worker | `options.model`, `options.code`, `options.traceback`, `hint_only` | Validated ```` ```diff ... ``` ```` unified diff string. |
| `chat_session` | Worker + Stream | `options.model`, `messages`, `mode` (`"learn"` \| `"edit"`), `workspace_context`, `use_gpu`, `num_gpu`, `num_ctx` | Streams `token` events; terminal `message` + `stats` telemetry. |
| `pull_model` | Worker + Stream | `model` or `name` | Streams download progress (`status [digest] (pct% — MiB)`), checks `"error"` chunks & `"status": "success"`. |
| `inline_complete` | Worker | `model`, `prefix`, `suffix`, `max_tokens`, `temperature`, `use_gpu`, `num_gpu` | FIM completion string via `POST /api/generate` (`<\|fim_prefix\|>...`). Preempted automatically by `chat_session`/`pull_model`. |

*(Note: `recommend_model` and `get_hardware_tiers` are Python functions in `hardware.py` returned inside `hardware_diagnostics`, not standalone JSONL tasks.)*

---

## 4. Ollama HTTP Integration (`ollama.py`)

Default base URL: `http://127.0.0.1:11434` (validated to require `http://` or `https://`).

| Endpoint | Method | Purpose | Timeout Policy |
|---|---|---|---|
| `/api/version` | `GET` | Server reachability & version string | `ollama_timeout_seconds` (default `5s`) |
| `/api/tags` | `GET` | Installed model discovery & metadata | `ollama_timeout_seconds` (default `5s`) |
| `/api/chat` | `POST` | Chat, explanations, tracebacks, patches | Streaming socket `max(timeout, first_token_timeout_seconds)` (`120s`), watchdog `first_token=120s`, `inactivity=120s`, `max_duration=600s` |
| `/api/generate` | `POST` | FIM `inline_complete` (and `keep_alive: 0` unload on Stop Ollama) | `max(timeout, 15s)` |
| `/api/pull` | `POST` | Streaming model download (`stream: true`) | `max(timeout, 600s)` |
| `/api/copy` | `POST` | Duplicate local model tag | `ollama_timeout_seconds` |
| `/api/delete` | `DELETE` | Delete installed local model | `ollama_timeout_seconds` |

### Inference Options Sent to Ollama

- **`num_gpu`:** `0` when `use_gpu: false` (forces CPU-only); `numGpuLayers` when `use_gpu: true` and `numGpuLayers >= 0`; `-1` (Ollama auto-offload) when `use_gpu: true` and `numGpuLayers < 0`.
- **`num_ctx`:** Positive integer passed when `localdev-ai.numCtx > 0`, or hardware-tier default (`2048` ultra-light, `4096` standard, `8192` performance) for `chat_session`.

---

## 5. Error Codes

| Code | Source | Meaning |
|---|---|---|
| `PROTOCOL_ERROR` | `__main__.py` | Invalid JSON, non-standard JSON constant (`NaN`/`Infinity`), empty line, or wrong `protocol_version`. |
| `REQUEST_TOO_LARGE` | `__main__.py` | JSONL line exceeds `64 KiB` UTF-8. |
| `REQUEST_INVALID` | `__main__.py`, `ollama.py` | Missing/invalid required fields, unsupported task/language, or invalid timeout/options. |
| `BUSY` | `__main__.py` | Another non-preemptible inference worker is currently active. |
| `MODEL_NOT_FOUND` | `__main__.py`, `ollama.py` | Selected model is empty or not present in `/api/tags`. |
| `OLLAMA_INVALID_ENDPOINT` | `ollama.py` | Endpoint does not start with `http://` or `https://`. |
| `OLLAMA_UNAVAILABLE` | `ollama.py` | Connection refused, DNS/socket error, or connection timeout. |
| `OLLAMA_HTTP_ERROR` | `ollama.py` | Non-2xx HTTP status from Ollama API. |
| `OLLAMA_INVALID_RESPONSE` | `ollama.py` | Malformed JSON, unexpected shape, or empty model response. |
| `OLLAMA_INFERENCE_ERROR` | `ollama.py` | Ollama emitted an `"error"` object inside `/api/chat` stream. |
| `OLLAMA_PULL_FAILED` | `ollama.py` | Ollama emitted an `"error"` object or HTTP error during `/api/pull`. |
| `OLLAMA_STREAM_INTERRUPTED` | `ollama.py` | Stream closed without `"done": true` (chat) or `"status": "success"` (pull). |
| `INVALID_PATCH` | `ollama.py` | `propose_patch` output was not wrapped in a valid ```` ```diff ```` fence. |
| `INFERENCE_TIMEOUT` | `ollama.py` | Watchdog exceeded first-token, inactivity, or max-duration limit. |
| `REQUEST_CANCELLED` | `__main__.py`, `ollama.py` | Request cancelled cooperatively via `cancel` message. |
| `INFERENCE_FAILED` | `__main__.py` | Unhandled unexpected exception in worker thread (logged to `stderr`). |
