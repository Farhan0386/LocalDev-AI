# LocalDev AI — Testing and Quality Plan

**Status:** Final baseline for the signed-off Phase 1–5 implementation

## 1. Testing goals

Validate useful coding assistance, safe patch behavior, reliability, hardware compatibility, privacy, and resource efficiency. Results should be reproducible and tied to documented hardware and model versions.

## 2. Test layers

### Unit tests
- Request validation and task routing.
- Prompt construction and context minimization.
- Error normalization.
- Model-fit heuristic boundaries.
- Hardware metric parsing.
- Patch validation and diff generation.
- Timeout and cancellation logic where implemented.

### Integration tests
- Engine can detect a running Ollama instance.
- Installed model discovery works.
- A simple explanation request completes.
- Missing Ollama/model produces actionable errors.
- Streaming is parsed correctly if implemented.
- Extension and engine communicate over the selected transport.

### Extension tests
- Commands register and invoke the expected task.
- Selected code is passed correctly.
- Loading and error states render appropriately.
- Patch preview appears before any edit.
- Reject leaves the document unchanged.
- Apply requires explicit user action.

### Manual acceptance tests
- Install/setup from documented instructions on a clean environment.
- Explain a short Python function.
- Diagnose an index error and explain the cause.
- Request a hint without immediately receiving the full solution.
- Review, reject, and apply a proposed minimal patch.
- Use the extension when no supported GPU is present.
- Test unavailable runtime/model and resource-pressure scenarios.

## 3. Quality evaluation set

The version-controlled benchmark set in `engine/scripts/benchmark.py` covers:
- Syntax errors.
- Index and key errors.
- Type errors.
- Incorrect conditions and loops.
- Function arguments and return values.
- Common standard-library usage.
- Small code explanation and patch-proposal tasks.

For each case, record the task, expected properties, model/runtime version, hardware, outcome, and reviewer notes. Avoid evaluating only on cherry-picked successful examples.

## 4. Metrics

| Metric | Method |
|---|---|
| Task success | Repeatable rubric for correctness and usefulness |
| Patch correctness | Tests plus manual review |
| Time to first token | Request start to first streamed output, if streaming exists |
| Total latency | Request start to completed response |
| Throughput | Tokens per second where available |
| RAM | Process/system measurements during test |
| GPU memory | Supported vendor tools/APIs |
| Temperature/power | Only when exposed by hardware and OS |
| Model fit | Compare estimate with observed load and successful inference |
| Reliability | Success/failure counts across defined scenarios |

Do not treat the recorded values as universal thresholds. Compare future
measurements with the same model, hardware, context, and Ollama settings.

## 5. Hardware compatibility matrix

Test and document, when available:
- CPU-only machine.
- NVIDIA GPU with limited VRAM.
- NVIDIA GPU with more VRAM.
- Different system RAM sizes.
- Ollama installed but stopped.
- Ollama running with no suitable model installed.
- Unsupported or unavailable GPU/temperature metrics.

Record OS, CPU, RAM, GPU/VRAM, driver/runtime versions, model, quantization, context settings, and test conditions.

## 6. Privacy and safety tests

- Confirm core coding tasks do not call a cloud AI API.
- Inspect network behavior and dependency telemetry.
- Confirm prompts/source code are not written to logs by default.
- Confirm generated code is not executed automatically.
- Confirm no patch is applied without explicit approval.
- Confirm errors do not leak source code or secrets.

## 7. Benchmark & Reliability Baseline

Run the dependency-free benchmark from the repository root:

```powershell
python engine\scripts\benchmark.py --model qwen3:4b
```

It exercises syntax-error explanation, index-error explanation, code explanation, and patch proposal through the local JSONL engine. The summary records time-to-first-token where streaming is available, total latency, peak engine RSS when exposed by the operating system, and a privacy verdict that fails for non-local Ollama endpoints. Requests are bounded and a timed-out inference is cancelled before the process exits.

The recorded live baseline used Windows with 16 logical CPU cores, approximately 14.7 GiB system RAM, an NVIDIA GeForce RTX 3050 Laptop GPU with 4 GiB VRAM, and Ollama `qwen3:4b`. Ubuntu 26.10 was also validated with Ollama `0.40.15` and `qwen2.5:1.5b`; streaming and cooperative cancellation completed successfully. Resource-pressure results depend on other applications, context size, quantization, and Ollama scheduling, so benchmark values are comparative rather than universal targets.

Known limitations: macOS remains unvalidated; process RSS metrics vary by operating system; non-streaming tasks have no TTFT value; model-fit estimates are conservative size heuristics; and local model size/VRAM bounds can prevent inference even when the engine itself starts.

## 8. Release checklist

- [x] Automated tests pass.
- [x] Known failure modes are tested.
- [x] Setup instructions are documented and verified in supported environments.
- [x] Model and hardware details accompany benchmark results.
- [x] Privacy/network behavior is documented.
- [x] Patch review and explicit consent work.
- [x] Limitations and unsupported metrics are clearly stated.
