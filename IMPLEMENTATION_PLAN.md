# LocalDev AI — Implementation Plan

**Status:** Complete — Phases 1–5 signed off on 2026-11-16.

## Phase 1 — Working foundation

- [x] Create the repository and VS Code extension scaffold.
- [x] Create the Python package, runtime policy, tests, and setup instructions.
- [x] Establish the JSONL transport and architecture decision record.
- [x] Verify extension compilation and engine tests.

## Phase 2 — Local model integration

- [x] Start and manage a long-lived Python 3.12+ child process with JSONL
      stdin/stdout, readiness, crash detection, timeouts, and shutdown.
- [x] Discover/select installed Ollama models through `/api/version` and
      `/api/tags`; never download models automatically.
- [x] Implement streaming `explain_code` through `/api/chat`.
- [x] Implement strict request validation, 64-KB input limits, structured
      errors, request correlation, cancellation, and retryable `BUSY`.
- [x] Package the engine source inside the extension and validate lifecycle
      behavior with Node tests.

## Phase 3 — Learning features and patches

- [x] Parse Python tracebacks and implement `explain_traceback`.
- [x] Implement hint-first prompts through the `hintOnly` setting.
- [x] Implement `propose_patch` with minimal unified diffs.
- [x] Show patch previews and require explicit Apply/Reject controls.
- [x] Validate malformed output, cancellation, and regression behavior.

## Phase 4 — Hardware intelligence

- [x] Detect CPU architecture/cores, system RAM, and optional NVIDIA GPU/VRAM
      using standard-library and lightweight OS/CLI probes.
- [x] Implement `hardware_diagnostics`, installed-model discovery, transparent
      `Comfortable`, `Tight`, `Too Large`, and `Unknown` fit estimates.
- [x] Register `localdev-ai.checkHardware` and display diagnostics in an
      OutputChannel with actionable setup guidance.

## Phase 5 — Performance and reliability

- [x] Add `engine/scripts/benchmark.py`, a dependency-free JSONL evaluation
      set covering syntax error, index error, code explanation, and patch
      proposal requests.
- [x] Measure TTFT where streaming is available, total latency, peak engine
      RSS, benchmark-process tracemalloc peak, and local-endpoint privacy.
- [x] Bound benchmark requests and send cancellation on timeout.
- [x] Document the Windows/Ubuntu baseline, resource-pressure and cancellation
      behavior, privacy boundary, and macOS/model-size limitations.

## Verification commands

From `extension/`:

```powershell
npm run compile
node --test tests/pythonEngine.test.js
```

From the repository root:

```powershell
$env:PYTHONPATH = "engine/src"
python -m pytest engine/tests
python engine/scripts/benchmark.py --model qwen3:4b
git diff --check
```

## Signed-off limitations

Windows and Ubuntu live workflows are verified. macOS and older Ollama
versions remain unvalidated. Hardware fit and performance results are
estimates affected by available memory, quantization, context size, Ollama
scheduling, and operating-system metric support.
