# LocalDev AI — Implementation Plan

**Status:** Draft v0.1  
**Strategy:** One testable phase at a time; do not generate the whole application in one step.

## Phase 1 — Working foundation

### Tasks
- [x] Create repository structure and `.gitignore`.
- [x] Scaffold a VS Code extension in TypeScript.
- [x] Create a Python package and virtual environment instructions.
- [ ] Add formatting/linting conventions and basic CI if practical.
- [x] Add unit-test scaffolding for extension and engine.
- [x] Document supported development environment.
- [x] Record architecture decisions that must be resolved before integration.

### Exit criteria
- Extension compilation is complete; loading in a development VS Code window
  remains unverified.
- Python package imports and its tests run.
- Setup instructions work on a clean environment remains unverified.

## Phase 2 — Local model integration

### Tasks
- [x] Use the approved long-lived Python child process with stdin/stdout JSONL,
      typed messages, protocol version, and correlation IDs.
- [x] Use user-managed Python 3.12+, detect and check compatibility, create an
      isolated LocalDev AI virtual environment, and avoid global package changes.
- [x] Start, monitor, time out, and gracefully stop the engine from the
      extension; prevent duplicate starts and clean up crashed processes.
- [ ] Keep bundled Python deferred; revisit only with owner approval.
- [x] Use Node.js 24 LTS for development and CI, VS Code 1.100 minimum, and
      VS Code's bundled extension-host Node.js runtime for users.
- [ ] Document Windows, Linux, and macOS process management, executable
      discovery, paths, permissions, and shutdown behavior.
- [x] Record the approved one-active-request limit, structured retryable
      `BUSY` rejection, no-MVP-queue policy, cancellation behavior, and initial
      configurable operational defaults.
- [x] Check Ollama reachability, retrieve its version, discover installed
      models, and validate selected-model configuration without downloading.
- [ ] Verify `GET /api/tags`, `GET /api/version`, and streaming `POST /api/chat`
      against current stable Ollama.
- [ ] Document a recommended default model with hardware and quality
      considerations; never download models silently.
- [x] Implement streaming `explain_code` end to end through `POST /api/chat`.
- [x] Add concise prompt and structured response/error handling.
- [x] Add JSONL streaming events with one terminal response or error.
- [x] Handle runtime unavailable, model missing, timeout, malformed chunks,
      interrupted streams, and empty responses.
- [x] Implement request-ID cancellation, cooperative stream closure,
      cancellation-safe terminal responses, and extension progress integration.
- [x] Test malformed protocol messages, engine startup/exit, cancellation,
      cleanup, duplicate cancellation, retry, and request isolation.
- [ ] Validate platform-specific behavior where environments are available.
- [ ] Test older Ollama versions before claiming compatibility.
- [x] Complete incoming JSONL schema validation and enforce the 64-KB
      request-size bound.
- [ ] Validate the complete workflow against a live Ollama server.

### Exit criteria
- A user can explain selected Python code from VS Code using a local model.
- Expected failure states produce actionable messages.
- No paid cloud AI API is required.

### Phase 2 audit status

The implemented and automated-test-covered scope includes lifecycle,
packaging, Ollama discovery, streaming explanations, cancellation, timeout
watchdogs, and extension-to-engine request correlation. Live Ollama validation,
Linux/macOS validation, older Ollama compatibility, full incoming schema
validation, and request-size enforcement remain incomplete.

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
