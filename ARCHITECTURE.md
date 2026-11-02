# LocalDev AI — System Architecture

**Status:** Accepted Phase 2 architecture; cross-platform validation and
model/hardware recommendations remain pending

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

The approved Phase 2 transport is a long-lived Python child process controlled
by the extension. The extension communicates through the child's stdin/stdout
using newline-delimited JSON (JSONL). stdout is reserved exclusively for
protocol messages; engine diagnostics go to stderr.

The protocol uses typed `request`, `event`, `response`, `error`, and `cancel`
messages with a protocol version and correlation ID. The engine validates
message types, protocol version, request IDs, supported tasks, allowed fields,
task-specific fields, and a 64-KB UTF-8 JSONL line limit before dispatch.
Malformed messages produce structured errors without terminating the process.
The extension owns startup, graceful shutdown, bounded forced termination, and
restart behavior.

The initial platform target is Windows, Linux, and macOS. Executable
discovery, platform-specific process management, paths, permissions, and
shutdown behavior must be documented and tested separately. No platform may
be described as validated before those tests are performed.

Python distribution is owner-approved as user-managed Python, with a minimum
version of 3.12. The extension detects Python, checks compatibility, creates
an isolated LocalDev AI virtual environment, and never modifies global Python
packages. Bundled Python remains deferred.

Development uses Node.js 24 LTS for development and CI. Users do not need a
separate Node.js installation; the extension uses VS Code's bundled
extension-host Node.js runtime. The minimum VS Code target is 1.100.

The approved Ollama integration uses the native local API at
`http://127.0.0.1:11434` without authentication for local requests:
`GET /api/tags` discovers models, `GET /api/version` reports the server
version, and streaming `POST /api/chat` performs inference. Models are never
downloaded automatically. Current stable Ollama is the target; older-version
compatibility requires testing.

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

For the initial implementation, only one inference request is active at a
time. Additional requests are rejected with a structured retryable `BUSY`
error; there is no request queue in the MVP. The user may cancel the active
request and retry. Cancellation uses request IDs, propagates to the engine,
closes the active Ollama streaming connection, ignores late results, and
restarts the engine only if it becomes unresponsive.

Initial configurable operational defaults are a 20-second engine startup
timeout, 5-second Ollama connection timeout, 120-second first-token timeout,
120-second streaming inactivity timeout, 10-minute maximum request duration,
64 KB maximum JSONL request message, and 2,048 maximum generated tokens.
These are initial defaults for hardware testing, not guaranteed performance
limits.

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

The transport, process lifecycle, supported runtime/toolchain policy, request
schema, streaming strategy, cancellation boundary, Ollama endpoints, and
initial operational defaults are recorded in
`ADR-001-EXTENSION-ENGINE-COMMUNICATION.md`. Cross-platform validation, older
Ollama compatibility, hardware metrics, model recommendation, and patch
representation remain decisions or tests to complete before their respective
implementation stages.

### Phase 2 Task 1 lifecycle implementation

The extension discovers a user-managed Python 3.12+ interpreter, creates a
virtual environment under VS Code global storage, and starts the engine with
stdio pipes. The environment is created with `python -m venv`; no global
package installation is performed. The current engine has no runtime
dependencies, so dependency installation is intentionally not performed.

The extension waits up to 20 seconds for the engine's unscoped JSONL
`event: "ready"` startup message. It captures stdout for protocol parsing and
stderr for diagnostics, prevents duplicate starts, detects startup failure and
unexpected exit, closes stdin for graceful shutdown, and force-terminates
after a bounded wait. The implementation is platform-neutral Node.js process
handling; Windows, Linux, and macOS remain unvalidated until tested on each
platform.

For packaged extensions, the build stages only `engine/src` into the VSIX
under `extension/engine/src`; activation resolves that bundled path rather
than a repository-relative path. The VSIX excludes tests, source maps,
`node_modules`, virtual environments, and Python bytecode. The virtual
environment is created below VS Code global storage. An existing valid
environment is reused after Python-version validation; an existing invalid
path is rejected without modification.

### Phase 2 Task 2 Ollama readiness implementation

Ollama communication remains inside the Python engine and uses the standard
library HTTP client. The extension sends `discover_models` and `select_model`
requests over the existing JSONL process channel; it never calls Ollama
directly. The endpoint defaults to loopback and is configurable through the
`localdev-ai.ollamaEndpoint` setting. The connection timeout defaults to five
seconds and is configurable through `localdev-ai.ollamaTimeoutSeconds`.

Task 2 retrieves only `/api/version` and `/api/tags`. It parses model names,
sizes, digests, timestamps, and safe metadata, accepts an empty list, and
reports malformed or unavailable responses with structured actionable errors.
The selected model is stored in the global VS Code configuration only after
the engine validates that it is currently installed. No model is downloaded
or recommended without sufficient hardware information.

### Phase 2 Task 4 streaming explanation implementation

The Python engine performs streaming `POST /api/chat` requests after
revalidating the selected model against `/api/tags`. Ollama newline-delimited
chunks are parsed in Python and non-empty `message.content` values are emitted
as request-scoped JSONL token events with sequence numbers beginning at one.
Exactly one terminal response or structured error follows the stream. The
extension correlates events by request ID, appends tokens incrementally, and
rejects duplicate or out-of-order sequences without displaying corrupted
output. Cancellation, patches, code execution, and code modification remain
out of scope.

The extension's explain command requires a Python editor selection and a
stored selected model, asks for an optional question, runs the request under a
VS Code progress notification, and displays the result in an output channel.

### Phase 2 Task 5 cancellation implementation

Inference runs in a Python worker thread so the main JSONL loop can continue
reading control messages. A matching cancellation message sets the active
request's cancellation event and closes its Ollama response; the worker then
suppresses late tokens and terminal output because the engine has already
emitted exactly one `REQUEST_CANCELLED` error. The extension connects the VS
Code progress cancellation token to the request ID, releases pending state on
the terminal message, and ignores events for completed requests. The active
request remains occupied until its worker has cleaned up, preserving the
one-active-inference rule during cancellation races.
