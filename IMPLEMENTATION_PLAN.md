# LocalDev AI — Implementation Plan

**Status:** Draft v0.1  
**Strategy:** One testable phase at a time; do not generate the whole application in one step.

## Phase 1 — Working foundation

### Tasks
- [ ] Create repository structure and `.gitignore`.
- [ ] Scaffold a VS Code extension in TypeScript.
- [ ] Create a Python package and virtual environment instructions.
- [ ] Add formatting/linting conventions and basic CI if practical.
- [ ] Add unit-test scaffolding for extension and engine.
- [ ] Document supported development environment.
- [ ] Record architecture decisions that must be resolved before integration.

### Exit criteria
- Extension builds and loads in a development VS Code window.
- Python package imports and its tests run.
- Setup instructions work on a clean environment.

## Phase 2 — Local model integration

### Tasks
- [ ] Define the extension-to-engine transport and request schema.
- [ ] Check Ollama reachability.
- [ ] Discover installed models and validate model selection.
- [ ] Implement `explain_code` end to end.
- [ ] Add concise prompt and response handling.
- [ ] Add streaming if supported by the chosen transport and runtime.
- [ ] Handle runtime unavailable, model missing, timeout, and invalid response cases.

### Exit criteria
- A user can explain selected Python code from VS Code using a local model.
- Expected failure states produce actionable messages.
- No paid cloud AI API is required.

## Phase 3 — Learning features and patches

### Tasks
- [ ] Add error/stack-trace explanation.
- [ ] Add hint-first mode.
- [ ] Add small snippet generation.
- [ ] Add minimal patch proposal.
- [ ] Add patch preview and explicit apply/reject controls.
- [ ] Explain what changed and why.
- [ ] Add tests for malformed or unsafe patch output.

### Exit criteria
- Patches are never silently applied.
- A user can review, reject, or apply a valid suggested change.
- Responses encourage verification with tests or manual execution.

## Phase 4 — Hardware intelligence

### Tasks
- [ ] Detect system RAM and CPU capabilities.
- [ ] Detect NVIDIA GPU/VRAM where supported.
- [ ] Check CUDA availability where relevant.
- [ ] Detect installed local models.
- [ ] Implement transparent model-fit heuristics.
- [ ] Explain estimates, trade-offs, and unsupported metrics.
- [ ] Add guidance for setup and model installation.

### Exit criteria
- Diagnostics work with and without an NVIDIA GPU.
- Missing metrics are reported honestly.
- Recommendations are labeled as estimates, not guarantees.

## Phase 5 — Performance and reliability

### Tasks
- [ ] Create a repeatable coding-task evaluation set.
- [ ] Measure time to first token and total latency.
- [ ] Measure CPU, RAM, GPU memory, and supported power/temperature indicators.
- [ ] Benchmark multiple compatible models on available hardware.
- [ ] Test resource-pressure and cancellation behavior.
- [ ] Test privacy/network behavior.
- [ ] Improve documentation and troubleshoot common failures.

### Exit criteria
- Results are reproducible and include hardware/model details.
- Known limitations are documented.
- No unsupported speed, accuracy, privacy, or thermal guarantees are claimed.

## Suggested repository layout

```text
localdev-ai/
├── extension/             # VS Code extension (TypeScript)
├── engine/                # Python local engine
├── tests/
│   ├── engine/
│   └── extension/
├── docs/                  # Optional expanded documentation
├── PRD.md
├── DESIGN.md
├── ARCHITECTURE.md
├── DATABASE.md
├── API_INTEGRATION.md
├── IMPLEMENTATION_PLAN.md
├── TESTING.md
└── README.md
```

Adjust the layout to the chosen packaging strategy; avoid duplicating documents.

## Development rule

Implement one phase, run its tests, inspect the result, and only then proceed. Never describe an unimplemented feature as complete.
