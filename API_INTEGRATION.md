# LocalDev AI — API and Integration Contract

**Status:** Proposed v0.1  
**Important:** The extension-to-engine transport is not yet selected.

## 1. Integration goals

- Use Ollama for local inference.
- Keep the core workflow independent of paid cloud AI APIs.
- Support concise answers and streaming where practical.
- Validate all requests and handle unavailable services cleanly.
- Send only the code context needed for the current task.

## 2. Ollama integration

The Python engine should call the locally configured Ollama API. Keep the base URL configurable and default to the standard local endpoint used by the installed runtime. Do not assume Ollama is installed, running, or has a required model available.

The implementation should:
- Check runtime reachability.
- Discover installed models through the runtime API.
- Validate the selected model before inference.
- Support streaming if the chosen endpoint/client permits it.
- Set explicit timeouts and handle cancellation where feasible.
- Normalize runtime errors into useful user-facing messages.
- Avoid logging source code or complete prompts by default.

Consult the installed Ollama version's official API documentation during implementation; endpoint details and response formats must be verified rather than guessed.

## 3. Internal request contract (proposed)

Example request shape:

```json
{
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

Fields are illustrative and must be validated. Avoid sending the whole file unless the task requires it.

Supported initial task names:
- `explain_code`
- `explain_error`
- `give_hint`
- `suggest_patch`
- `generate_snippet`
- `check_setup`
- `benchmark_model`

## 4. Proposed response contract

```json
{
  "status": "ok",
  "task": "explain_code",
  "message": "Short explanation",
  "patch": null,
  "warnings": []
}
```

For a patch task, `patch` should contain a structured, reviewable change rather than instructions to overwrite a file blindly. The final schema and patch representation remain open decisions.

## 5. Error categories

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

Errors should include a short explanation and a practical next step, while avoiding sensitive request content.

## 6. Patch safety

- Never apply a generated patch automatically.
- Validate the patch and target document state before applying.
- Show a diff or equivalent review surface.
- Require an explicit user action.
- Make rejection easy and preserve the original text.
- Never automatically execute generated code.

## 7. Security and network behavior

- If using local HTTP between components, bind to loopback and validate inputs.
- Do not expose a local engine to the LAN by default.
- Avoid arbitrary URL fetching or shell command execution from model output.
- Explain that downloading models requires network access.
- Test actual network activity and document dependencies that may communicate externally.

## 8. Decisions before implementation

Choose and document:
1. Extension ↔ engine transport.
2. Runtime endpoint/client and version compatibility.
3. Streaming event format.
4. Cancellation and timeout policy.
5. Patch format and validation.
6. Model configuration and context limits.
