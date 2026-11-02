# ADR-001: Extension-to-Engine Communication

- **Status:** Accepted
- **Date:** 2026-11-02
- **Scope:** Phase 2 local model integration

## Context

LocalDev AI consists of a VS Code extension written in TypeScript and a
Python engine responsible for request validation, prompt construction, Ollama
integration, hardware diagnostics, and response normalization. Phase 1
established both foundations but deliberately left their communication
mechanism, lifecycle, request contract, streaming behavior, cancellation, and
timeouts undecided.

The product is local-first and targets students using modest hardware. The
architecture must therefore avoid an unauthenticated network service by
default, minimize source-code exposure, support incremental output, handle
runtime failures clearly, and remain portable across the supported development
platforms. The initial workflow is a single VS Code extension communicating
with a local engine; a multi-client engine is not a current requirement.

## Problem

The project owner approved the communication approach, runtime/toolchain
policy, Ollama integration policy, initial concurrency, and operational
defaults on 2026-11-02. Cross-platform validation and model/hardware
recommendations remain subject to testing.

The decision must address:

- portability across supported platforms;
- security and local privacy boundaries;
- engine startup, restart, and shutdown behavior;
- streaming partial responses;
- cancellation and timeout behavior;
- request/response performance;
- implementation and testing complexity.

## Options considered

### Option A: Child process with stdio and JSON Lines

The extension starts one long-lived Python engine process and communicates over
stdin/stdout. Each protocol message is one newline-delimited JSON object.
Engine diagnostics go to stderr and are not mixed with protocol output.

**Pros**

- Strong local security boundary without opening a listening port.
- The extension owns startup, shutdown, restart, and process lifetime.
- Portable on Windows, macOS, and Linux when the Python executable can be
  located or the engine is packaged.
- Streaming maps naturally to a sequence of typed JSON events.
- No port allocation, discovery, authentication token, or firewall behavior.
- Good performance for small requests because communication stays in-process
  boundaries with pipe I/O and avoids HTTP framing.
- The protocol can remain language-neutral and independently testable.

**Cons**

- The extension must locate or package a compatible Python runtime.
- A crashed or wedged process requires explicit restart handling.
- Multiplexing and correlation IDs must be implemented in the protocol.
- Stdio is less convenient than HTTP for external tools or future clients.
- A hard process termination may be needed when an in-flight Ollama request
  cannot be cancelled cooperatively.

### Option B: Loopback HTTP service

The extension starts or connects to an engine HTTP server bound only to
`127.0.0.1`, using JSON requests and a streaming response such as
newline-delimited JSON or server-sent events.

**Pros**

- Familiar request/response semantics and broad tooling support.
- Streaming, status codes, and concurrent requests are well understood.
- Easier to inspect and exercise manually during development.
- Future clients could connect without changing the engine protocol.
- The engine can be restarted independently if lifecycle ownership is
  explicitly designed.

**Cons**

- A local port is an additional attack surface even when bound to loopback.
- An unauthenticated listener must not be exposed beyond the host; an
  authentication or capability-token design adds complexity.
- Port selection, collision handling, readiness checks, and shutdown cleanup
  are required.
- The extension must discover the correct engine instance and protect against
  connecting to an unrelated process.
- Process ownership and orphan cleanup are more complex than stdio.
- HTTP adds modest framing and server overhead that is unnecessary for the
  single-client Phase 2 workflow.

### Option C: Named pipe or Unix domain socket

The extension and engine communicate through an operating-system local IPC
endpoint, using a framed or JSON Lines protocol.

**Pros**

- No TCP listening port and a smaller network attack surface.
- Can provide local peer/ACL controls on some platforms.
- Supports streaming and bidirectional communication.
- Efficient for local requests.

**Cons**

- Windows named pipes and Unix domain sockets require different setup and
  cleanup paths.
- Endpoint naming, permissions, stale endpoints, and discovery add complexity.
- Cross-platform testing and packaging are more involved than stdio.
- The extension still needs to manage engine startup and process lifetime.
- There is no current product requirement for multiple independent clients
  that would justify this complexity.

### Option D: One-shot subprocess per request

The extension starts a new Python process for each request and exchanges one
request and one response over stdin/stdout.

**Pros**

- Very simple lifecycle isolation and cleanup.
- A failed request cannot permanently poison a long-lived engine process.
- No listening port or persistent IPC endpoint.

**Cons**

- Startup overhead on every request harms responsiveness.
- Streaming and cancellation become process-management concerns for every
  request.
- Repeated interpreter startup is wasteful on modest hardware.
- Runtime/model readiness checks and shared state cannot be reused cleanly.
- Less suitable for interactive commands and future benchmarks.

## Comparison

Ratings are relative to the Phase 2 requirement for one VS Code extension and
one local Python engine. Higher is better.

| Approach | Portability | Security | Lifecycle | Streaming | Cancellation | Performance | Complexity |
|---|---:|---:|---:|---:|---:|---:|---:|
| Long-lived stdio/JSONL | High | High | High | High | Medium | High | Medium |
| Loopback HTTP | High | Medium | Medium | High | Medium | High | Medium |
| Named pipe / Unix socket | Medium | High | Medium | High | Medium | High | High |
| One-shot stdio | High | High | High | Medium | High | Low | Low initially |

“Cancellation” is medium for the long-lived options because the transport can
cancel a request, but the engine and Ollama client must also cooperate. The
extension may need to terminate and restart the engine when a provider call
cannot be interrupted safely.

## Accepted decision

Adopt **a long-lived Python child process controlled by the VS Code extension,
communicating over stdin/stdout with newline-delimited JSON (JSONL)** for the
initial Phase 2 implementation.

The protocol should use:

- one JSON object per line;
- a required protocol version and correlation ID;
- separate `request`, `event`, `response`, `error`, and `cancel` message
  types;
- stdout exclusively for protocol messages;
- stderr for diagnostics, with source code and prompts excluded by default;
- bounded request sizes and strict schema validation;
- one active inference request initially;
- graceful shutdown followed by a bounded forced termination and restart path.

This best matches the current single-client workflow and local-first privacy
requirements. It avoids exposing a service port while retaining streaming,
structured errors, and future protocol evolution. HTTP remains a reasonable
future option if independent clients, remote development, or engine
independence becomes a real requirement.

Reject additional inference requests while one is active with a structured
retryable `BUSY` error. No request queue is used in the MVP. The user may
cancel the active request and retry.

The initial supported platforms are Windows, Linux, and macOS. Platform
specific process management, executable discovery, paths, permissions, and
shutdown behavior must be documented and tested before claiming validation for
each platform.

Python distribution is **owner-approved** as a user-managed Python installation:
the extension detects Python, checks compatibility, creates an isolated
LocalDev AI virtual environment, and never modifies global Python packages.
The minimum supported Python version is 3.12. Bundled Python is deferred.

Development uses Node.js 24 LTS for development and CI. Node.js is not a
separate user requirement; the extension uses VS Code's bundled
extension-host Node.js runtime. The minimum VS Code compatibility target is
1.100.

Ollama uses its native local API at `http://127.0.0.1:11434` without
authentication for local requests. Model discovery uses `GET /api/tags`,
server version uses `GET /api/version`, and inference uses streaming
`POST /api/chat`. Models are never downloaded automatically. The target is
current stable Ollama; older-version compatibility must be established by
testing and must not be claimed beforehand.

Initial operational defaults are:

- Python engine startup timeout: 20 seconds.
- Ollama connection timeout: 5 seconds.
- First-token timeout: 120 seconds.
- Streaming inactivity timeout: 120 seconds.
- Maximum request duration: 10 minutes.
- Maximum JSONL request message: 64 KB.
- Default maximum generated output: 2,048 tokens.

These are configurable where practical and are initial defaults for hardware
testing, not guaranteed performance limits. Cancellation uses request IDs,
propagates to the Python engine, closes the active Ollama streaming
connection, ignores late results for cancelled requests, and restarts the
engine only if it becomes unresponsive.

## Proposed protocol schema

### Request

```json
{
  "protocol_version": "1",
  "type": "request",
  "request_id": "uuid",
  "task": "explain_code",
  "language": "python",
  "code": "print('hello')",
  "question": "Explain this code",
  "context": {
    "diagnostics": [],
    "file_name": "example.py"
  },
  "options": {
    "hint_first": false,
    "stream": true
  }
}
```

Required Phase 2 fields: `protocol_version`, `type`, `request_id`, `task`,
`language`, and `code`. `question`, `context`, and `options` are optional with
task-specific validation. The engine must reject unknown task names,
unsupported languages, malformed types, and requests exceeding a documented
size limit. The extension should send only selected code and relevant
diagnostics.

### Streaming event

```json
{
  "protocol_version": "1",
  "type": "event",
  "request_id": "uuid",
  "event": "token",
  "sequence": 1,
  "text": "This code"
}
```

The engine emits ordered `token` events followed by exactly one terminal
`response` or `error` message. A terminal response includes the complete
normalized result so the extension does not need to reconstruct correctness
from tokens alone.

### Successful response

```json
{
  "protocol_version": "1",
  "type": "response",
  "request_id": "uuid",
  "task": "explain_code",
  "status": "ok",
  "message": "Short explanation",
  "patch": null,
  "warnings": []
}
```

The Phase 2 `explain_code` result should keep `patch` null. A structured patch
format must be approved before patch-producing tasks are implemented.

### Cancellation

```json
{
  "protocol_version": "1",
  "type": "cancel",
  "request_id": "uuid"
}
```

Cancellation is best effort. The engine should stop producing events, cancel
the provider request when supported, and return a terminal cancellation error
or an explicit cancelled response. The extension must not treat a cancelled
request as successful.

## Error-handling strategy

Every rejected request or failed operation returns a structured error tied to
the request ID:

```json
{
  "protocol_version": "1",
  "type": "error",
  "request_id": "uuid",
  "code": "OLLAMA_UNAVAILABLE",
  "message": "Ollama is not reachable.",
  "action": "Start Ollama and retry the request.",
  "retryable": true,
  "details": null
}
```

The stable error code is for programmatic handling; `message` and `action`
are concise user-facing text. `details` must not contain source code, full
prompts, credentials, or raw provider payloads by default. Unexpected internal
exceptions should be logged as diagnostics without exposing their traceback to
the user, while preserving a correlation ID for troubleshooting.

Initial error categories should include the existing documented categories:

- `ENGINE_UNAVAILABLE`
- `OLLAMA_UNAVAILABLE`
- `MODEL_NOT_INSTALLED`
- `MODEL_NOT_FOUND`
- `REQUEST_INVALID`
- `INFERENCE_TIMEOUT`
- `INFERENCE_FAILED`
- `OUTPUT_INVALID`
- `HARDWARE_METRIC_UNAVAILABLE`
- `RESOURCE_PRESSURE`
- `REQUEST_CANCELLED`
- `PROTOCOL_ERROR`

The extension should map errors to actionable UI states, allow retry only when
`retryable` is true, and never apply a patch from an errored, incomplete, or
malformed response.

## Consequences and trade-offs

### Benefits

- Keeps the default communication path off the network.
- Gives the extension clear ownership of engine lifetime.
- Supports incremental UI updates without committing to HTTP.
- Makes protocol messages easy to capture in tests without logging source
  content.
- Leaves an upgrade path to HTTP or another IPC mechanism if requirements
  change.

### Costs and risks

- Python runtime discovery or packaging must be solved before release.
- The extension must detect, report, and recover from process crashes and
  startup failures.
- Cooperative cancellation across the extension, engine, and Ollama may be
  incomplete.
- A single active request limits concurrency until there is a measured need
  for multiplexing.
- JSONL framing requires strict handling of newlines, malformed messages, and
  stdout contamination.

## Open questions and approval gates

The following decisions remain open; this ADR does not silently resolve them:

### Phase 2 blockers

1. Document and test platform-specific process management, executable
    discovery, paths, permissions, and shutdown behavior on Windows, Linux, and
    macOS. No cross-platform validation is claimed before those tests.
2. Establish older-version Ollama compatibility through testing; do not claim
    compatibility that has not been verified.
3. Confirm streaming semantics, including token event granularity and the
    terminal-message invariant.
4. Define the model configuration policy: recommended default model,
    user-selected installed alternatives, context limit, and behavior when no
    model is installed. No specific model is selected by this ADR.

### Decisions needed before later phases

5. Define supported hardware metrics and platform-specific unavailable-value
    behavior.
6. Select the model shortlist and reproducible evaluation dataset.
7. Approve the structured patch representation and validation rules before
    patch-producing tasks.
8. Decide whether any local history or preferences are needed; SQLite remains
    optional and is not required for Phase 2.
9. Define privacy-safe diagnostics, retention, and whether opt-in telemetry is
    permitted; the current product documents no cloud coding API.

## Next steps for the remaining implementation and testing gates

Complete the remaining platform-process documentation and validation, test
older Ollama compatibility, select and document the recommended default model,
then implement the Phase 2 transport, Ollama readiness checks, model
discovery/selection, and `explain_code` flow. Add protocol, failure-state,
streaming, timeout, and cancellation tests before expanding the feature set.
