# LocalDev AI — UX and Interface Design

**Status:** Implemented (Final Release — Copilot-Style Sidebar & Native VS Code Integration)

## 1. Design Goals

- **Native VS Code Feel:** Built exclusively with `--vscode-*` theme tokens (`--vscode-sideBar-background`, `--vscode-foreground`, `--vscode-input-background`, `--vscode-button-background`, `--vscode-panel-border`, etc.) so both dark and light themes look cohesive.
- **Clutter-Free Predictability:** Replace crowded multi-control bars with a compact Copilot-style header, collapsible single-open drawers for **History** and **Models**, a clean message stream, and an auto-growing composer footer.
- **Explicit User Control:** No silent file modifications or automatic code execution. Every generated snippet offers explicit **Copy** / **Insert**, and every workspace write/delete renders an approval card.
- **Transparent Local Resource Status:** Surface Ollama online/offline state, hardware fit (`Comfortable`, `Tight`, `Too Large`), `dGPU: ON/OFF` state, download progress, and per-response `tok/s` / `TTFT` / `RAM` telemetry.

## 2. Primary Surfaces

### A. Copilot-Style Sidebar (`localdev-ai.chatView`)

1. **Compact Header:**
   - **Top row:** Ollama status dot (`online`/`offline`), active session title, `+` New Chat, `History` drawer toggle, `Models` drawer toggle, `dGPU: ON/OFF` pill, and Ollama `▶ Start` / `⏹ Stop` button.
   - **Subrow:** Active model `<select>`, hardware fit badge, and `Tab: ON/OFF` inline autocomplete toggle.
2. **Collapsible History Drawer:**
   - Lists saved per-workspace sessions sorted newest-first with message counts.
   - Supports one-click session switching, **Clear** current messages, **Rename** (via VS Code `showInputBox`), and **Delete** (via VS Code modal confirmation).
3. **Collapsible Model Manager Drawer:**
   - **Pull Any Tag:** Text input + **Pull** / **Cancel** buttons + link to Ollama library.
   - **Installed Models:** Displays model name, GiB size, fit label, **Use** (or Active highlight), **Copy** (prompts destination name via `showInputBox`), and **Delete** (with modal confirmation).
   - **Recommended & Curated Catalog:** Displays hardware-tiered models (`Ultra-Light`, `Standard`, `Performance`) with category badges (`coding`, `general`, `reasoning`) and one-click **Pull** or **Use**.
4. **Structured Message Stream (`#chat-stream`):**
   - **Empty State:** Welcome summary with one-click starter prompt chips (`Explain active file`, `Find bugs in selection`, `Summarize workspace`).
   - **User & Assistant Messages:** Distinct visual separation; code blocks extracted before inline markdown formatting to prevent escaping bugs, rendered with **Copy** and **Insert** buttons wired via event delegation.
   - **CRUD & Diff Cards:** Action badge (`CREATE`, `UPDATE`, `DELETE`, `READ`), relative file path, collapsible diff/content preview, **✓ Approve / Apply** and **✕ Reject** buttons, and **Retry** on failure.
   - **Status Strip:** Compact footer strip showing throughput (`tok/s` & `TTFT`), execution mode (`GPU: Auto` / `CPU Only` + `ctx`), and free system RAM.
5. **Composer Footer:**
   - Context chips: active editor file + line range, attached `@file` chips (removable), `+ @file` picker, and `+ @workspace` directory-tree toggle.
   - Auto-growing `<textarea>` with live `@` file-mention autocomplete popup.
   - Mode switch (`Ask` vs `Edit`) and `Send` / `Stop` controls.

### B. Command Palette & Editor Integrations

- Palette commands for chat (`openChat`, `newChat`), model management (`refreshModels`, `selectModel`, `checkHardware`), Python learning (`explainCode`, `explainTraceback`, `proposePatch`), and toggles (`toggleAutocomplete`, `toggleGpu`).
- `proposePatch` opens a native VS Code `vscode.diff` side-by-side preview and requires modal confirmation (`Apply` / `Reject`).
- `LocalDevInlineCompletionProvider` renders ghost-text Tab completions cleanly without blocking chat requests.

## 3. Core Interaction States

1. **Ollama Offline:** Status dot red; onboarding card offers `▶ Start Ollama`, `Install`, and `Retry`.
2. **No Models Installed:** Status dot green; onboarding card recommends a primary hardware-matched model plus varied alternatives and a `Browse All` shortcut to the Model Manager.
3. **Ready:** Onboarding card hidden; composer enabled; model selector and fit badge populated.
4. **Pulling Model:** Progress banner shows layer digest, percentage, and MiB progress with `Cancel` control; resets cleanly on completion, cancellation, or error.
5. **Streaming / Generating:** `Send` swaps to `Stop`; blinking cursor streams Markdown incrementally; telemetry strip shows `Generating...` and updates with `tok/s`, `TTFT`, `execution_mode`, and `RAM` upon completion.
6. **Review Required:** `Edit` mode tool proposals pause on pending approval cards until the user clicks `Approve / Apply` or `Reject`.

## 4. Accessibility & Usability Checks

- All colors inherit VS Code theme variables for high contrast in light, dark, and high-contrast themes.
- Status never relies on color alone (`Offline`/`Online`, `dGPU: ON`/`OFF`, `Tab: ON`/`OFF`, `Approve`/`Reject` carry explicit text labels).
- Keyboard shortcuts: `Enter` sends prompt, `Shift+Enter` inserts newline, `Escape` closes `@` mention popup.
- Modal inputs/confirmations use native VS Code host dialogs (`showInputBox`, `showWarningMessage`) rather than browser `prompt()`/`confirm()`, which are blocked in VS Code webviews.
