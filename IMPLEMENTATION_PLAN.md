# LocalDev AI — Implementation Plan

**Status:** Complete — Phases 1–7 and Final Release Polish verified on 2026-11-26.

## Phase 1 — Working Foundation

- [x] Create the repository, `.gitignore`, and VS Code extension scaffold.
- [x] Create the Python 3.12+ `localdev_ai_engine` package, test configuration, and setup instructions.
- [x] Establish the JSONL transport and `ADR-001-EXTENSION-ENGINE-COMMUNICATION.md`.
- [x] Verify extension TypeScript compilation and engine tests.

## Phase 2 — Local Model Integration

- [x] Start and manage a long-lived Python 3.12+ child process with JSONL `stdin`/`stdout`, 20-second `ready` handshake, crash detection, timeouts, and shutdown.
- [x] Discover and select installed Ollama models through `/api/version` and `/api/tags`; never download models automatically.
- [x] Implement streaming `explain_code` through `/api/chat`.
- [x] Implement strict JSONL schema validation, 64-KiB input limits, structured errors, request correlation, cooperative cancellation, and retryable `BUSY`.
- [x] Stage `engine/src` inside the VSIX and validate lifecycle behavior with Node tests.

## Phase 3 — Learning Features & Patches

- [x] Parse Python tracebacks (`tracebackParser.ts`) and implement `explain_traceback`.
- [x] Implement hint-first prompts through `localdev-ai.hintOnly`.
- [x] Implement `propose_patch` with minimal unified diffs (`diffUtils.ts`).
- [x] Show native diff previews and require explicit Apply/Reject confirmation.

## Phase 4 — Hardware Intelligence

- [x] Detect CPU architecture/cores, system RAM, and optional NVIDIA GPU/VRAM (`nvidia-smi`).
- [x] Implement `hardware_diagnostics`, `estimate_model_fit` (`Comfortable`, `Tight`, `Too Large`, `Unknown`), and setup guidance.
- [x] Register `localdev-ai.checkHardware` to display diagnostics in the `LocalDev AI Hardware` OutputChannel.

## Phase 5 — Performance & Reliability

- [x] Add `engine/scripts/benchmark.py`, a dependency-free 4-case JSONL benchmark covering syntax error, index error, code explanation, and patch proposal.
- [x] Measure TTFT, total latency, peak engine RSS, `tracemalloc` peak, and local-endpoint privacy verification.
- [x] Bound benchmark requests and send cooperative `cancel` on timeout.
- [x] Document Windows and Ubuntu 26.10 baselines and known limitations.

## Phase 6 — Interactive Sidebar & Workspace Agent

- [x] Register the Activity Bar container and `WebviewViewProvider` (`localdev-ai.chatView`).
- [x] Implement guided onboarding (`ollama_offline`, `no_models`, `ready`) and hardware-aware model recommendations.
- [x] Implement `workspaceContext.ts` (`getActiveEditorContext`, `@file` resolution, `collectDirectoryTree`) and multi-turn `chat_session`.
- [x] Implement user-approved CRUD tool cards (`create`, `update`, `delete`, `read`) backed by `vscode.workspace.fs`.

## Phase 7 — Local Runtime Controls & Session Management

- [x] Auto-execute bounded `read` actions to feed file observations back to the model.
- [x] Add final-response `tok/s`, TTFT, and RAM telemetry plus Start/Stop Ollama controls.
- [x] Add `pull_model`, `copy_model`, `delete_model`, and `inline_complete` (Tab Autocomplete).
- [x] Persist per-project chat sessions in `workspaceState` with DOM message capping (`maxRenderedMessages`).

## Final Evolution — Reliability, Copilot-Style UI, dGPU & Documentation Overhaul

- [x] Fix automatic **Insert** and **Approve / Apply** via `_lastActiveEditor` fallback, `editor.edit` / `WorkspaceEdit` verification, range reveal, git-diff header support, and raw `codeBlockStore` rendering.
- [x] Redesign `chatViewProvider.ts` into a clean Copilot-style sidebar using native `--vscode-*` theme tokens with collapsible History and Model Manager drawers and delegated event handling.
- [x] Fix multi-turn context overflows/hangs via `maxHistoryTurns`, `workspaceContext.ts` total char budgeting, `_fitPayloadToJsonlLimit`, explicit `num_ctx`, `inferenceTimeoutSeconds` (`120s`), `REQUEST_TOO_LARGE` `request_id` sniffing, and `inline_complete` preemption.
- [x] Add **dGPU: ON/OFF** toggle (`useGpu`, `numGpuLayers`, `localdev-ai.toggleGpu`) mapped to Ollama `options.num_gpu`.
- [x] Harden `pull_model` error/completion detection, expand `MODEL_CATALOG` recommendations, add full Model Manager (pull/use/copy/delete), and fix History Manager rename/delete dialogs.
- [x] Synchronize all repository documentation (`README.md`, `ARCHITECTURE.md`, `API_INTEGRATION.md`, `DESIGN.md`, `IMPLEMENTATION_PLAN.md`, `TESTING.md`, `PROJECT_PROGRESS.md`).

## Verification Commands

From the repository root:

```powershell
# Extension compile, 13 Node unit tests, and VSIX package
npm --prefix extension run compile
npm --prefix extension test
npm --prefix extension run package

# Python engine regression suite (40 pytest tests)
$env:PYTHONPATH = "engine/src"
python -m pytest engine/tests -v

# Live Ollama benchmark
python engine/scripts/benchmark.py --model qwen3:4b

# Repository diff hygiene check
git diff --check
```

## Signed-Off Limitations

Windows and Ubuntu 26.10 live workflows are verified; **macOS** and older Ollama versions remain unvalidated. Hardware fit labels and benchmark numbers are estimates influenced by quantization, context size, system load, and OS metric availability.
