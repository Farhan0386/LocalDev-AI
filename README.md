# LocalDev AI

A lightweight, learning-focused AI coding assistant for Visual Studio Code, designed for students and beginner programmers using modest hardware.

## Vision

LocalDev AI helps users understand programming errors, debug code, generate small snippets, and review minimal fixes inside VS Code. It is designed around local inference, initially using Ollama, so core coding assistance does not require a paid cloud AI API.

## Core features

1. **VS Code-native assistance** — explain selected code, diagnose errors, and access help through editor commands.
2. **Concise answers** — focused explanations and small changes rather than unnecessary long responses.
3. **Learning-first debugging** — hints, explanations, minimal patches, and verification guidance.
4. **Hardware-aware model selection** — inspect supported system resources and estimate model compatibility.
5. **Resource-conscious operation** — measure inference costs and avoid unnecessary background work.

## Proposed technology

- VS Code Extension API + TypeScript
- Python local engine
- Ollama for local model inference
- pytest and VS Code extension tests
- Optional NVIDIA metrics through `nvidia-smi`/NVML where supported

These are proposed technologies and should be validated during implementation.

## Project status

**Planning / early prototype.** The documents describe intended behavior; they do not mean the features have already been implemented.

## Documentation

- [PRD.md](PRD.md) — requirements, scope, and success criteria
- [DESIGN.md](DESIGN.md) — UX and interaction design
- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow
- [DATABASE.md](DATABASE.md) — persistence decision and optional schema
- [API_INTEGRATION.md](API_INTEGRATION.md) — proposed integration contract
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — phased development
- [TESTING.md](TESTING.md) — quality, performance, and compatibility testing

## Initial setup

### Prerequisites

- Python 3.10 or newer
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

Run the engine tests:

```powershell
python -m pytest engine/tests
```

The current engine foundation exposes only an in-process health status check.
Ollama, extension-to-engine communication, and AI features are not implemented yet.

## Privacy and safety

- Core inference should be local.
- Model downloads require network access and should be clearly explained.
- Source code should not be sent to cloud AI APIs by default.
- Generated patches must be reviewed before application.
- Generated code must not execute automatically.
- Actual dependency network behavior must be tested and documented.

## Development approach

Build incrementally: foundation → Ollama integration → learning features and patch review → hardware diagnostics → benchmarking and reliability. Run tests at each stage and record measured results rather than promising unsupported performance.
