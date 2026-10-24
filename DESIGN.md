# LocalDev AI — UX and Interface Design

**Status:** Draft v0.1

## 1. Design goals

- Feel native to VS Code and avoid distracting users from their code.
- Keep answers concise, legible, and educational.
- Make model readiness and system limitations understandable.
- Require user approval before changing files.

## 2. Main surfaces

### Activity Bar / Sidebar
Suggested sections:
- **Ask:** Explain code, diagnose errors, hints, and focused questions.
- **Patch review:** Show proposed changes and rationale.
- **Model & hardware:** Ollama status, installed model, hardware summary, and compatibility notes.
- **Diagnostics:** Recent request status and troubleshooting guidance, without storing source code by default.

### Command Palette
Initial commands:
- `LocalDev AI: Explain Selected Code`
- `LocalDev AI: Explain Error`
- `LocalDev AI: Give Me a Hint`
- `LocalDev AI: Suggest a Fix`
- `LocalDev AI: Check Local Setup`
- `LocalDev AI: Benchmark Model`

### Editor interactions
- Use selected text as context when possible.
- Offer code actions only when relevant.
- Show proposed changes as a diff or equivalent review surface.
- Require explicit Apply/Reject actions.

## 3. Core interaction states

1. **Ready:** Ollama is reachable and a model is selected.
2. **Checking:** Hardware or runtime diagnostics are running.
3. **Generating:** Response is being produced; allow cancellation if practical.
4. **Review required:** A patch is proposed but has not been applied.
5. **Unavailable:** Show a clear cause and next step (runtime stopped, model missing, or unsupported metric).
6. **Resource constrained:** Explain the detected pressure and suggest a smaller model or reduced context; do not promise thermal protection.

## 4. Response layout

Prefer this order:
1. **What happened:** One or two sentences.
2. **Suggested fix:** Small code block or patch, when appropriate.
3. **Why it works:** Brief explanation.
4. **Verify:** A test or command the learner can run.

Hint mode should give a hint first and not reveal the full answer unless the user asks.

## 5. Visual language

Follow VS Code theme and accessibility settings where possible rather than forcing a fixed palette. Use clear hierarchy, restrained spacing, readable code blocks, and native editor conventions. Avoid decorative UI that competes with source code.

## 6. Accessibility and usability

- Keyboard-accessible commands and controls.
- Clear labels; do not rely on color alone for status.
- Preserve readable contrast in light and dark themes.
- Keep error messages specific and actionable.
- Distinguish facts, estimates, and unavailable measurements.
- Make patch review understandable to a beginner.

## 7. Design acceptance checks

- A user can invoke explain/debug from the editor without switching applications.
- A user can understand whether a response is still generating.
- No patch is silently applied.
- The interface explains missing runtime/model states.
- UI remains usable in both light and dark VS Code themes.
