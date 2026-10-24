# LocalDev AI — System Architecture

**Status:** Proposed architecture v0.1

## 1. High-level design

```text
VS Code
  └── TypeScript Extension
       ├── Commands, sidebar, editor context
       ├── Response presentation and patch review
       └── Extension ↔ Local Engine communication
                         │
                         ▼
                  Python Local Engine
                    ├── Request/task routing
                    ├── Prompt construction
                    ├── Ollama client
                    ├── Hardware diagnostics
                    ├── Model compatibility estimates
                    └── Benchmarking/resource checks
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
          Ollama API          OS / Hardware tools
        Local model runtime   RAM, CPU, GPU metrics
```

## 2. Component responsibilities

### VS Code extension (TypeScript)
- Register commands and editor actions.
- Read only the code context needed for the current request.
- Present streamed answers where supported.
- Display patch previews and collect explicit approval.
- Communicate engine status and errors to the user.

### Python engine
- Validate requests and construct task-specific prompts.
- Call the configured local inference runtime.
- Normalize errors and responses.
- Inspect available system resources using platform-supported tools.
- Recommend models using documented heuristics and report uncertainty.
- Run repeatable benchmarks.

### Ollama
- Download/manage local models and provide inference through its local API.
- Is an external runtime dependency; the project does not train its own foundation model.

### Testing layer
- Unit-test request routing, compatibility estimates, and error handling.
- Integration-test the engine against a running Ollama instance where available.
- Test extension commands and patch-review behavior.
- Benchmark on documented hardware configurations.

## 3. Extension ↔ engine transport

**Decision pending.** Evaluate a local HTTP service, stdio/subprocess protocol, or another simple mechanism before implementation. Compare startup lifecycle, streaming, portability, error handling, security, and packaging. Avoid selecting a transport without a concrete trade-off analysis.

Whichever mechanism is selected should:
- Bind locally only if using a network listener.
- Validate request shape and size.
- Avoid exposing an unauthenticated service to the network.
- Support clear timeouts, cancellation where feasible, and structured errors.
- Keep source context to the minimum required.

## 4. Request lifecycle

1. User invokes a command in VS Code.
2. Extension collects selected code and relevant diagnostic context.
3. Extension sends a typed request to the Python engine.
4. Engine validates request, checks runtime/model readiness, and routes task.
5. Engine calls Ollama.
6. Response is returned or streamed to the extension.
7. Extension renders explanation and, if applicable, a proposed patch.
8. User reviews and explicitly accepts/rejects the patch.
9. User verifies the result by running tests or code.

## 5. Hardware diagnostics

- Prefer supported OS APIs and well-defined tools.
- NVIDIA GPU metrics may use `nvidia-smi` and/or NVML when installed.
- CPU, RAM, CUDA, temperature, and power information vary by platform and hardware.
- Missing metrics must be reported as unavailable, not fabricated.
- Compatibility is an estimate; measure actual performance.

## 6. Initial technology candidates

| Area | Candidate | Notes |
|---|---|---|
| Editor | VS Code Extension API + TypeScript | Native integration |
| Engine | Python | Diagnostics, inference orchestration, tests |
| Inference | Ollama | Local model runtime |
| CLI diagnostics | Typer + Rich | Optional, if a CLI is useful |
| GPU monitoring | `nvidia-smi`, NVML | NVIDIA-specific |
| Python analysis | `ast` | Initial lightweight structural checks |
| Tests | pytest + extension tests | Unit and integration coverage |
| Local persistence | SQLite only if needed | Not required for MVP |

## 7. Failure handling

- Ollama unavailable → show how to start/check it.
- Model missing → explain how to pull/select a compatible model.
- Request timeout → show concise error and allow retry.
- Hardware metrics unavailable → continue with partial diagnostics.
- Model output malformed → do not apply a patch; show safe error.
- Resource pressure → stop optional work where feasible and explain limits.

## 8. Security and privacy boundaries

- Default inference path is local.
- No generated code is executed automatically.
- Patch application requires user approval.
- Avoid logging source code, secrets, or full prompts by default.
- Document model-download network activity.
- Verify dependencies and actual network behavior.

## 9. Architecture decisions to record

Before implementation, document the selected transport, process lifecycle, supported platforms, request schema, streaming strategy, cancellation behavior, and model-selection heuristics in an ADR or this document.
