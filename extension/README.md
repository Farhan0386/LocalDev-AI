# LocalDev AI

Local-first, privacy-preserving AI coding assistant for Visual Studio Code powered by a bundled Python 3.12+ JSONL engine and local Ollama models.

- **Sidebar Chat & Editor Integration:** Copilot-style sidebar (`Ask` & `Edit` modes), `@file` and `@workspace` context, `dGPU: ON/OFF` offload toggle, Model Manager (pull/copy/delete + multi-tier catalog), History Manager, and Tab FIM autocomplete.
- **Safe Workspace Edits:** Explicit user approval cards (`Approve / Apply` / `Reject`) for file edits and clean code insertion at cursor.
- **Runtime:** Stages `engine/src` inside the packaged extension and creates an isolated Python virtual environment in VS Code `globalStorageUri`.
