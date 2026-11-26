# LocalDev AI — Testing and Quality Plan

**Status:** Verified baseline for the completed Phase 1–7 + Final Release implementation (40 Python pytest tests, 13 Node extension tests).

## 1. Testing Goals

Validate useful coding assistance, safe patch/insertion behavior, multi-turn context stability, hardware diagnostics, local privacy, and resource efficiency using reproducible automated suites and live local benchmarks.

## 2. Automated Test Suites

### Python Engine Suite (`engine/tests/` — 40 tests)

- **`test_engine.py` (3 tests):** Package import and `health_status()` isolation.
- **`test_ollama.py` (7 tests):** `/api/version` & `/api/tags` parsing, empty model list handling, malformed metadata errors, timeout/unavailable actionable errors, endpoint scheme validation, and `validate_selected_model`.
- **`test_explain.py` (13 tests):** Non-streaming & streaming `explain_code`, empty/missing model rejection, malformed responses, HTTP/timeout errors, cooperative cancellation before token emission, and watchdog first-token timeout closing the response stream.
- **`test_protocol.py` (7 tests):** JSONL request correlation, sequential `token` events, `BUSY` concurrency rejection, duplicate cancellation idempotency, malformed JSON/type/field rejection, `REQUEST_TOO_LARGE` 64-KiB enforcement with `request_id` sniffing, and sequential request handling.
- **`test_chat.py` (10 tests):** Hardware-tier `recommend_model` + varied `MODEL_CATALOG` alternatives, `chat_session_stream` workspace context & mode prompts, `use_gpu: false` (`num_gpu: 0`), `num_ctx` option forwarding & multi-turn history trimming, `pull_model` progress/error-chunk/incomplete-stream handling, `copy_model` & `delete_model`, FIM `inline_complete`, and `tok/s`/`ttft_ms` telemetry.

Run from repository root:

```powershell
$env:PYTHONPATH = "engine/src"
python -m pytest engine/tests -v
```

### Extension Node Suite (`extension/tests/` — 13 tests)

- **`diffUtils.test.js` (3 tests):** Clean unified diff patching, mismatched hunk rejection, and git metadata (`diff --git`, `index`) + ```` ```patch ```` fence stripping.
- **`pythonEngine.test.js` (10 tests):** Python 3.12+ discovery & incompatible interpreter rejection, safe `venv` validation without overwriting existing directories, single-start deduplication & `ready` handshake, startup timeout, unexpected exit -> `ERROR`, ordered streaming token delivery, out-of-order token rejection, cancellation & retry, unkeyed error rejection (no hang), and 64-KiB payload guard.

Run from repository root:

```powershell
npm --prefix extension test
```

## 3. Manual & Interactive Verification Checklist

- Install `extension/localdev-ai-0.0.1.vsix` into VS Code and confirm sidebar renders cleanly in both Dark and Light themes.
- Verify first-run onboarding when Ollama is stopped (`Start Ollama`), when no models exist (`Pull`), and when ready.
- Toggle `dGPU: ON` / `dGPU: OFF` and verify `telemetry-exec` updates (`GPU` vs `CPU Only`).
- Pull a custom model tag, cancel a pull mid-stream, copy a model, and delete a model with confirmation.
- Send 5+ multi-turn prompts with `@file` and `@workspace` context attached; confirm no context-overflow hangs or `5s` timeout errors occur.
- Click **Insert** on generated code blocks (with and without editor focus) and **✓ Approve / Apply** on a proposed `Edit` card; verify code is inserted verbatim without HTML entity corruption and cursor scrolls to the edit.
- Create, switch, rename, and delete sessions in the **History** drawer.
- Toggle `Tab: ON/OFF` and confirm inline ghost-text completions do not block chat turns.

## 4. Quality Evaluation & Benchmark (`engine/scripts/benchmark.py`)

Run the dependency-free local JSONL benchmark from the repository root against a running Ollama server:

```powershell
python engine/scripts/benchmark.py --model qwen3:4b
```

The script executes four representative cases (`syntax error`, `index error`, `code explanation`, `patch proposal`) and reports:
- **TTFT** (for streaming `explain_code`) and **Total latency** per case.
- **Peak engine RSS** (Windows `GetProcessMemoryInfo` / Linux `VmHWM` / macOS `ps`) and benchmark `tracemalloc` peak.
- **Privacy verdict:** `PASS` only when `--ollama-endpoint` resolves to `127.0.0.1`, `::1`, or `localhost`.

## 5. Recorded Live Validation & Known Limitations

- **Windows live baseline:** Verified with Ollama `0.40.13` (`qwen3:4b`) on 16 logical CPU cores, ~14.7 GiB RAM, and NVIDIA GeForce RTX 3050 Laptop GPU (4 GiB VRAM).
- **Ubuntu 26.10 live validation:** Verified with Ollama `0.40.15` (`qwen2.5:1.5b`) for model discovery, 548 streaming events, cooperative `REQUEST_CANCELLED`, and `OLLAMA_UNAVAILABLE`.
- **Known limitations:** **macOS remains unvalidated**; older Ollama releases remain unvalidated; process RSS availability varies by OS; non-streaming tasks have no TTFT metric; and model-fit labels are conservative heuristics.

## 6. Release Checklist

- [x] Extension TypeScript compilation passes (`npm --prefix extension run compile`).
- [x] All 13 Node extension tests pass (`npm --prefix extension test`).
- [x] All 40 Python engine tests pass (`pytest engine/tests`).
- [x] VSIX package builds cleanly (`npm --prefix extension run package` -> `extension/localdev-ai-0.0.1.vsix`).
- [x] Privacy, patch consent, context budgeting, and dGPU/CPU controls are implemented and documented.
- [x] Platform and measurement limitations are clearly stated.
