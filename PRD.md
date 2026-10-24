# LocalDev AI — Product Requirements Document

**Status:** Draft v0.1  
**Project type:** Semester 3 engineering project  
**Product:** VS Code extension + local Python engine

## 1. Product summary

LocalDev AI is a lightweight, learning-focused AI coding assistant integrated into Visual Studio Code. It helps students and beginner programmers understand errors, debug code, generate small snippets, and review minimal fixes without repeatedly switching to a browser or requiring a paid cloud AI API.

The initial implementation targets Python and uses Ollama for local model inference.

## 2. Problem

Students can lose focus when they repeatedly copy code into external AI tools. Paid services may have usage limits, large local models may not fit modest computers, and complete AI-generated solutions can hinder learning. Local model setup can also be confusing, while inference may consume significant CPU, RAM, GPU memory, power, and thermal headroom.

## 3. Target users

- Engineering and computer science students.
- Beginner and self-taught programmers.
- Budget-constrained users who prefer local inference.
- Users who want greater control over source code and network activity.

The first version is not aimed at autonomous, large-codebase professional agents.

## 4. Product principles

1. **Local-first:** Core coding assistance must not require a paid cloud AI API.
2. **Learning-first:** Explain the reason behind a fix; offer hints before full solutions.
3. **Minimal changes:** Prefer targeted patches over wholesale rewrites.
4. **User control:** Show changes before applying them; never execute generated code automatically without consent.
5. **Resource awareness:** Avoid unnecessary inference and make hardware limitations clear.
6. **Evidence over promises:** Measure latency, quality, and resource use instead of making unsupported guarantees.

## 5. Goals and non-goals

### Goals
- Provide focused coding help inside VS Code.
- Explain selected code, errors, and stack traces.
- Suggest small code fixes and explain what changed.
- Help users identify a compatible local model.
- Measure performance and resource consumption on supported systems.
- Operate gracefully when Ollama, a model, or GPU metrics are unavailable.

### Non-goals for the first release
- Training a foundation model.
- Replacing VS Code or building a complete IDE.
- An autonomous agent that edits an entire repository.
- Mandatory accounts, cloud inference, or paid API keys.
- Authentication, multi-agent orchestration, MCP, or a database without a demonstrated need.
- Guaranteeing that every laptop stays cool or that all requests meet a fixed latency.

## 6. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Install and use the extension within VS Code | Must |
| FR-02 | Explain selected code | Must |
| FR-03 | Explain common errors and stack traces | Must |
| FR-04 | Provide hint-first and solution modes | Must |
| FR-05 | Propose minimal code patches and explain them | Must |
| FR-06 | Require explicit review/approval before applying a patch | Must |
| FR-07 | Connect to local Ollama and handle unavailable service/model states | Must |
| FR-08 | Stream output where supported by the chosen integration | Should |
| FR-09 | Detect installed models and inspect hardware where supported | Should |
| FR-10 | Estimate model fit using RAM/VRAM and explain uncertainty | Should |
| FR-11 | Benchmark response latency and resource usage | Should |
| FR-12 | Reduce optional work when resource pressure is detected | Could |
| FR-13 | Begin with Python support; add languages later | Must |

## 7. User workflow

1. Install the VS Code extension and configure Ollama.
2. Run a hardware/model readiness check.
3. Write code normally.
4. Select code or invoke an explain/debug/hint command.
5. Review a concise explanation and suggested patch.
6. Accept or reject the patch, then run tests or execute the program manually.

## 8. UX requirements

- Keep responses concise and directly relevant.
- Prefer a focused explanation, a small patch, and a short rationale.
- Make service/model errors actionable.
- Clearly distinguish detected facts from estimates.
- Avoid sending an entire file when selected code is sufficient.
- Keep proposed edits reviewable and reversible.

## 9. Privacy and safety

- Core inference should remain local.
- Explain network activity needed to download models.
- Do not transmit source code to cloud AI services by default.
- Avoid logging source code or secrets unnecessarily.
- Do not execute AI-generated code automatically.
- Test and document actual network behavior; local inference alone is not proof that every dependency is offline.

## 10. Success criteria

- Users can request help without leaving VS Code.
- A repeatable task set evaluates explanation usefulness and patch correctness.
- Measure time to first token and total response time.
- Record CPU, RAM, GPU memory, and available power/temperature indicators.
- Test model recommendations against actual compatibility and measured performance.
- Test missing Ollama, missing models, invalid code, no supported GPU, and resource pressure.
- Verify core coding tasks do not depend on a cloud AI API.

## 11. Delivery phases

1. Repository, extension skeleton, Python package, environment, and tests.
2. Ollama integration, streaming, and explain-code command.
3. Error explanation, hints, code generation, minimal patches, and review flow.
4. Hardware detection, model discovery, and compatibility estimates.
5. Benchmarks, resource management, reliability, and documentation.

## 12. Open decisions

- Exact extension-to-Python communication mechanism.
- Supported operating systems and minimum hardware.
- Which hardware metrics are available on each platform.
- Whether any local history is needed; SQLite is optional, not a prerequisite.
- Model shortlist and reproducible evaluation dataset.

Resolve these through architecture design and experiments rather than assumptions.
