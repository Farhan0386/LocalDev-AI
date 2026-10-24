# LocalDev AI — Testing and Quality Plan

**Status:** Draft v0.1

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

Build a small, version-controlled set of Python examples covering:
- Syntax errors.
- Index and key errors.
- Type errors.
- Incorrect conditions and loops.
- Function arguments and return values.
- Common standard-library usage.
- Small code explanation and refactoring tasks.

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

Do not invent universal thresholds before collecting a baseline. Establish targets after measuring representative student hardware.

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

## 7. Release checklist

- [ ] Automated tests pass.
- [ ] Known failure modes are tested.
- [ ] Setup instructions are verified on a clean environment.
- [ ] Model and hardware details accompany benchmark results.
- [ ] Privacy/network behavior is documented.
- [ ] Patch review and explicit consent work.
- [ ] Limitations and unsupported metrics are clearly stated.
