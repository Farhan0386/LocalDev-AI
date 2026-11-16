# LocalDev AI

A lightweight, learning-focused AI coding assistant for Visual Studio Code, designed for students and beginner programmers using modest hardware.

## Vision

LocalDev AI helps users understand programming errors, debug code, and review
minimal fixes inside VS Code. It uses local Ollama inference, so core coding
assistance does not require a paid cloud AI API.

## Core features

1. **VS Code-native assistance** — explain selected code, diagnose errors, and access help through editor commands.
2. **Concise answers** — focused explanations and small changes rather than unnecessary long responses.
3. **Learning-first debugging** — hints, explanations, minimal patches, and verification guidance.
4. **Hardware-aware model selection** — inspect supported system resources and estimate model compatibility.
5. **Resource-conscious operation** — measure inference costs and avoid unnecessary background work.

## Implemented technology

- VS Code Extension API + TypeScript
- Python 3.12+ local engine over JSONL
- Ollama for local model inference
- pytest and VS Code extension tests
- NVIDIA GPU metrics through `nvidia-smi` where supported
- Dependency-free benchmark and local privacy verification

## Project status

**Complete prototype.** Phases 1–5 are implemented and signed off. Windows and Ubuntu validation is complete; macOS remains unvalidated.

## Documentation

- [PRD.md](PRD.md) — requirements, scope, and success criteria
- [DESIGN.md](DESIGN.md) — UX and interaction design
- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow
- [DATABASE.md](DATABASE.md) — persistence decision and optional schema
- [API_INTEGRATION.md](API_INTEGRATION.md) — implemented JSONL and Ollama contract
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — completed implementation phases
- [TESTING.md](TESTING.md) — quality, performance, and compatibility testing

## Initial setup

### Prerequisites

- Python 3.12 or newer
- Node.js and npm for the VS Code extension
- VS Code for extension development

### Python engine

From the repository root, create and activate a virtual environment:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

Install the engine and its test dependencies in development mode:

```powershell
python -m pip install --editable "engine[test]"
```

Run the engine tests and extension tests:

```powershell
python -m pytest engine/tests
```

```powershell
Set-Location extension
npm test
```

The engine supports `check_setup`, Ollama model discovery/selection,
streaming `explain_code`, `explain_traceback`, `propose_patch`, and
`hardware_diagnostics`. The extension also provides model management,
explanation, traceback, patch-review, and `localdev-ai.checkHardware`
commands.

Run the Phase 5 baseline from the repository root:

```powershell
python engine\scripts\benchmark.py --model qwen3:4b
```

The benchmark reports TTFT where streaming is available, total latency, peak
engine RSS, and whether the configured Ollama endpoint is local.

## Privacy and safety

- Core inference is local through the configured Ollama endpoint.
- Model downloads require network access and should be clearly explained.
- Source code should not be sent to cloud AI APIs by default.
- Generated patches must be reviewed before application.
- Generated code must not execute automatically.
- Actual dependency network behavior must be tested and documented.

## Development and verification

Run `npm run compile` in `extension/`, `npm test` in `extension/`, and
`PYTHONPATH=engine/src pytest engine/tests` from the repository root. Model-fit
and benchmark results are estimates; hardware, quantization, context size,
Ollama scheduling, and operating-system support affect observed performance.
