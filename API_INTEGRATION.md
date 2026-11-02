# LocalDev AI — API and Integration Contract

**Status:** Accepted Phase 2 contract; cross-platform validation, older Ollama
compatibility, and model/hardware recommendations remain pending.

## 1. Integration goals

- Use Ollama for local inference.
- Keep the core workflow independent of paid cloud AI APIs.
- Support concise answers and streaming where practical.
- Validate all requests and handle unavailable services cleanly.
- Send only the code context needed for the current task.

## 2. Ollama integration

The Python engine uses Ollama's native local API. Keep the base URL
configurable, defaulting to `http://127.0.0.1:11434`. Do not assume Ollama is
installed, running, or has a required model available.

The implementation should:
- Check runtime reachability.
- Discover installed models through the runtime API.
- Validate the selected model before inference.
- Support streaming if the chosen endpoint/client permits it.
- Set explicit timeouts and handle cancellation where feasible.
- Normalize runtime errors into useful user-facing messages.
- Avoid logging source code or complete prompts by default.
- Use `GET /api/tags` for model discovery.
- Use `GET /api/version` for the Ollama server version.
- Use streaming `POST /api/chat` for inference.
- Do not authenticate local requests.
- Discover available installed models before inference and present a
  recommended default model without silently downloading it.
- Allow the user to select another installed model.
- If the selected or recommended model is unavailable, return actionable
  guidance to install or select a model; never download one automatically.
- The recommended model must be documented with hardware-fit and quality
  considerations before it is selected. This document does not select a
  specific model.

Tasks 2 and 3 implement Ollama readiness and explanation through the Python
engine only:
`GET /api/version` and `GET /api/tags`. The default endpoint is
`http://127.0.0.1:11434`; the extension passes a validated user setting and a
configurable five-second connection timeout to the engine. The engine returns
safe structured errors for unreachable Ollama, timeouts, invalid JSON, invalid
model metadata, and missing selected models. Empty model lists are valid and
never trigger a download.

Task 4 uses streaming `POST /api/chat` with the selected installed model.
The engine sends a focused learner-oriented prompt containing the selected
Python code and optional question, with `stream: true`. It parses newline-
delimited chunks, forwards non-empty `message.content` values as ordered token
events, and returns validated
`message.content` as the structured response message; `patch` remains `null`.
Empty code, missing models, unavailable/timeout/HTTP failures, and malformed
responses produce actionable structured errors. The extension never sends code
directly to Ollama and never executes or modifies the selected code.

Target current stable Ollama. Establish older-version compatibility through
testing and do not claim unverified version compatibility. Endpoint details and
response formats must still be verified against official documentation during
implementation.

## 3. Extension ↔ engine JSONL protocol

The extension starts a long-lived Python child process and communicates over
stdin/stdout. Each line is one JSON object. stdout contains protocol messages
only; diagnostics use stderr. Every message includes `protocol_version` and,
for request-scoped messages, `request_id`.

The protocol supports these typed messages:

- `request` — submit a validated task.
- `event` — stream incremental output.
- `response` — terminal successful result.
- `error` — terminal failed result.
- `cancel` — request best-effort cancellation.

The extension owns startup and shutdown. It must detect startup failure,
unexpected exit, malformed stdout, and stale processes. Shutdown is graceful
first, followed by bounded termination and restart when required.

The protocol does not otherwise define a health handshake. For lifecycle
readiness, the engine emits one unscoped startup event immediately after it
initializes:

```json
{"protocol_version":"1","type":"event","event":"ready"}
```

The extension considers the process `RUNNING` only after receiving this event
within the 20-second startup timeout. This is a deliberately small, backward-
compatible lifecycle addition; request-scoped events and terminal messages
retain the existing correlation-ID rules.

The packaged extension resolves the engine from its bundled `engine/src`
directory. Its isolated environment is stored under VS Code global storage;
the current engine has no runtime dependencies, so packaging and startup do
not install packages into either the global interpreter or an existing
environment.

## 4. Request contract

Example request shape:

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

Phase 2 requests require `protocol_version`, `type`, `request_id`, and a
supported `task`. `explain_code` additionally requires `language: "python"`
and non-empty string `code`; optional `question`, `context`, and `options`
must have object/string shapes appropriate to their use. Unsupported fields,
tasks, message types, invalid request IDs, non-standard JSON constants, and
malformed types are rejected with structured errors. Every incoming JSONL line
is limited to 64 KiB when encoded as UTF-8; oversized lines are rejected
without terminating the engine.

Phase 2 task names:
- `explain_code`
- `check_setup`
- `discover_models`
- `select_model`

Later-phase task names:

- Phase 3: `explain_error`, `give_hint`, `suggest_patch`, `generate_snippet`
- Phase 5: `benchmark_model`

## 5. Response and streaming contract

```json
{
  "protocol_version": "1",
  "type": "response",
  "request_id": "uuid",
  "status": "ok",
  "task": "explain_code",
  "message": "Short explanation",
  "patch": null,
  "warnings": []
}
```

Streaming uses ordered `event` messages, initially with `event: "token"` and
text content:

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

Token events are followed by exactly one terminal `response` or `error`.
The terminal response contains the complete normalized message. Phase 2
`explain_code` responses keep `patch` set to `null`; patch representation
remains deferred until Phase 3.

Only one inference request is active initially. Additional requests are
rejected with a structured retryable `BUSY` error; there is no request queue in
the MVP. The user may cancel the active request and retry.

Cancellation uses:

```json
{
  "protocol_version": "1",
  "type": "cancel",
  "request_id": "uuid"
}
```

Cancellation is best effort. Request IDs propagate cancellation to the Python
engine, which stops producing events and closes the active Ollama streaming
connection. Late results for cancelled requests are ignored. If cleanup
cannot complete cooperatively, the extension restarts the engine only when it
becomes unresponsive. Cancellation returns a terminal cancellation error or
explicit cancelled response.

The Python engine keeps its stdin loop responsive by running the active
inference in a worker thread. A matching `cancel` message sets a cooperative
cancellation event, closes the current Ollama response, and emits one
`REQUEST_CANCELLED` terminal error. Duplicate or non-matching cancellation
messages have no effect. The extension binds the VS Code progress cancellation
token to this control message and stops appending tokens after the terminal
error.

Initial configurable operational defaults are: 20 seconds for Python engine
startup, 5 seconds for Ollama connection, 120 seconds for first token, 120
seconds for streaming inactivity, 10 minutes for maximum request duration,
64 KB for the maximum JSONL request message, and 2,048 tokens for default
maximum generated output. These are initial defaults for hardware testing, not
guaranteed performance limits.

## 6. Error categories and handling

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
- `REQUEST_TOO_LARGE`

Errors include the request ID, stable code, concise message, practical action,
retryability, and optional non-sensitive details:

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

Errors must not expose source code, full prompts, credentials, or raw provider
payloads by default. The extension maps errors to actionable UI states and
never applies incomplete or malformed output.

## 7. Patch safety

- Never apply a generated patch automatically.
- Validate the patch and target document state before applying.
- Show a diff or equivalent review surface.
- Require an explicit user action.
- Make rejection easy and preserve the original text.
- Never automatically execute generated code.

## 8. Security and network behavior

- If using local HTTP between components, bind to loopback and validate inputs.
- Do not expose a local engine to the LAN by default.
- Avoid arbitrary URL fetching or shell command execution from model output.
- Explain that downloading models requires network access.
- Test actual network activity and document dependencies that may communicate externally.

## 9. Remaining decisions before implementation

Choose and document:
1. Platform-specific process behavior and validation on Windows, Linux, and
   macOS.
2. Older Ollama compatibility established through testing.
3. Recommended default model, with hardware and quality rationale.
4. Model context limits and user configuration behavior.
5. Patch format and validation before Phase 3.
6. Hardware metrics and evaluation dataset before later phases.
