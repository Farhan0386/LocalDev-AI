import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonEngine } from './pythonEngine';
import { parsePythonTraceback } from './tracebackParser';
import { ChatViewProvider } from './chatViewProvider';
import { applyUnifiedDiff } from './diffUtils';

let engine: PythonEngine | undefined;

function modelNames(response: { message?: unknown } | undefined): string[] {
  const message = response?.message;
  if (!message || typeof message !== 'object' || !('models' in message)) {
    return [];
  }
  const models = (message as { models?: unknown }).models;
  return Array.isArray(models)
    ? models.map((model) => (model && typeof model === 'object' && 'name' in model ? (model as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === 'string')
    : [];
}

function hardwareMessage(response: { message?: unknown } | undefined): Record<string, unknown> {
  const message = response?.message;
  return message && typeof message === 'object' ? message as Record<string, unknown> : {};
}

function ollamaOptions(): Record<string, unknown> {
  const configuration = vscode.workspace.getConfiguration('localdev-ai');
  return {
    ollama_endpoint: configuration.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
    ollama_timeout_seconds: configuration.get<number>('ollamaTimeoutSeconds', 5),
    hint_only: configuration.get<boolean>('hintOnly', false),
  };
}

function proposedSource(patch: string, original: string): string | undefined {
  const content = patch
    .replace(/^```diff\s*/i, '')
    .replace(/\s*```[\s\S]*$/i, '')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ '));
  const source = original.split(/\r?\n/);
  const result: string[] = [];
  let sourceIndex = 0;
  let hunkFound = false;

  for (let index = 0; index < content.length; index += 1) {
    const hunk = content[index].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!hunk) continue;
    hunkFound = true;
    const start = Number(hunk[1]) - 1;
    if (start < sourceIndex || start > source.length) return undefined;
    result.push(...source.slice(sourceIndex, start));
    sourceIndex = start;
    for (index += 1; index < content.length && !content[index].startsWith('@@ '); index += 1) {
      const line = content[index];
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ')) {
        if (source[sourceIndex] !== line.slice(1)) return undefined;
        result.push(source[sourceIndex]);
        sourceIndex += 1;
      } else if (line.startsWith('-')) {
        if (source[sourceIndex] !== line.slice(1)) return undefined;
        sourceIndex += 1;
      } else if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else {
        return undefined;
      }
    }
    index -= 1;
  }

  if (!hunkFound) return undefined;
  result.push(...source.slice(sourceIndex));
  return result.join('\n');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  engine = new PythonEngine({
    sourcePath: path.join(context.extensionPath, 'engine', 'src'),
    environmentPath: path.join(context.globalStorageUri.fsPath, 'venv'),
  });
  try {
    await engine.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`LocalDev AI engine could not start: ${message}`);
  }
  const disposable = vscode.commands.registerCommand(
    'localdev-ai.helloWorld',
    () => {
      void vscode.window.showInformationMessage('Hello World from LocalDev AI!');
    },
  );
  const refreshModels = vscode.commands.registerCommand(
    'localdev-ai.refreshModels',
    async () => {
      try {
        const response = await engine?.request('discover_models', {
          ...ollamaOptions(),
        });
        const names = modelNames(response);
        const selected = vscode.workspace.getConfiguration('localdev-ai').get<string>('selectedModel', '');
        if (names.length === 0) {
          void vscode.window.showInformationMessage('No Ollama models are installed. Install a model in Ollama, then refresh; LocalDev AI will not download models automatically.');
          return;
        }
        if (selected && !names.includes(selected)) {
          void vscode.window.showWarningMessage(`Selected Ollama model "${selected}" is no longer installed. Choose another installed model.`);
        }
        void vscode.window.showInformationMessage(`Found ${names.length} installed Ollama model${names.length === 1 ? '' : 's'}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const checkHardware = vscode.commands.registerCommand(
    'localdev-ai.checkHardware',
    async () => {
      if (!engine) {
        void vscode.window.showErrorMessage('The LocalDev AI engine is not running. Reload the extension and retry.');
        return;
      }
      try {
        const response = await engine.request('hardware_diagnostics', ollamaOptions());
        const message = hardwareMessage(response);
        const hardware = message.hardware as { cpu?: { cores?: unknown; architecture?: unknown }; memory?: { total_bytes?: unknown; available_bytes?: unknown }; gpu?: { present?: unknown; name?: unknown; vram_total_bytes?: unknown } } | undefined;
        const models = Array.isArray(message.models) ? message.models : [];
        const guidance = Array.isArray(message.guidance) ? message.guidance : [];
        const output = vscode.window.createOutputChannel('LocalDev AI Hardware');
        output.clear();
        output.appendLine('LocalDev AI hardware diagnostics');
        output.appendLine('');
        output.appendLine(`CPU: ${hardware?.cpu?.cores ?? 'unknown'} cores, ${hardware?.cpu?.architecture ?? 'unknown'}`);
        output.appendLine(`RAM: ${formatBytes(hardware?.memory?.available_bytes)} available / ${formatBytes(hardware?.memory?.total_bytes)} total`);
        output.appendLine(`GPU: ${hardware?.gpu?.present ? `${hardware.gpu.name ?? 'detected'} (${formatBytes(hardware.gpu.vram_total_bytes)} VRAM)` : 'not detected'}`);
        output.appendLine('');
        output.appendLine('Model fit estimates:');
        for (const model of models) {
          if (model && typeof model === 'object') {
            const item = model as { name?: unknown; fit?: unknown; reason?: unknown; guidance?: unknown };
            output.appendLine(`- ${item.name ?? 'unknown'}: ${item.fit ?? 'Unknown'} — ${item.reason ?? ''}`);
            if (typeof item.guidance === 'string') output.appendLine(`  ${item.guidance}`);
          }
        }
        output.appendLine('');
        output.appendLine('Setup guidance:');
        for (const item of guidance) if (typeof item === 'string') output.appendLine(`- ${item}`);
        output.show(true);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const selectModel = vscode.commands.registerCommand(
    'localdev-ai.selectModel',
    async () => {
      try {
        const response = await engine?.request('discover_models', ollamaOptions());
        const names = modelNames(response);
        if (names.length === 0) {
          void vscode.window.showInformationMessage('No Ollama models are installed. Install a model in Ollama, then try again.');
          return;
        }
        const selected = await vscode.window.showQuickPick(names, { placeHolder: 'Select an installed Ollama model' });
        if (selected) {
          await engine?.request('select_model', { ...ollamaOptions(), model: selected });
          await vscode.workspace.getConfiguration('localdev-ai').update('selectedModel', selected, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(`Selected Ollama model: ${selected}`);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const explainCode = vscode.commands.registerCommand(
    'localdev-ai.explainCode',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Select Python code before requesting an explanation.');
        return;
      }
      if (editor.document.languageId !== 'python') {
        void vscode.window.showInformationMessage('The explain-code command currently supports Python files only.');
        return;
      }
      const model = vscode.workspace.getConfiguration('localdev-ai').get<string>('selectedModel', '').trim();
      if (!model) {
        void vscode.window.showErrorMessage('No Ollama model is selected. Use “LocalDev AI: Select Ollama Model” first.');
        return;
      }
      const question = await vscode.window.showInputBox({
        prompt: 'Optional question about the selected Python code',
        placeHolder: 'For example: Why is this loop needed?',
      });
      if (question === undefined) {
        return;
      }
      if (!engine) {
        void vscode.window.showErrorMessage('The LocalDev AI engine is not running. Reload the extension and retry.');
        return;
      }
      const activeEngine = engine;
      const output = vscode.window.createOutputChannel('LocalDev AI Explanation');
      output.clear();
      output.appendLine(`Model: ${model}`);
      output.appendLine('');
      output.show(true);
      try {
        const response = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'LocalDev AI is explaining the selected code...' },
          (_progress, progressToken) => activeEngine.request('explain_code', {
            ...ollamaOptions(),
            model,
            code: editor.document.getText(editor.selection),
            question,
          }, (event) => {
            output.append(event.text);
          }, progressToken),
        );
        if (!response || typeof response.message !== 'string') {
          throw new Error('The engine returned an empty explanation.');
        }
        output.show(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('request was cancelled')) {
          void vscode.window.showInformationMessage('LocalDev AI explanation cancelled.');
        } else {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }
    },
  );
  const explainTraceback = vscode.commands.registerCommand(
    'localdev-ai.explainTraceback',
    async () => {
      const raw = await vscode.window.showInputBox({
        prompt: 'Paste a Python traceback',
        ignoreFocusOut: true,
      });
      if (raw === undefined) {
        return;
      }
      const traceback = parsePythonTraceback(raw);
      if (!traceback) {
        void vscode.window.showErrorMessage('The input is not a valid Python traceback.');
        return;
      }
      const model = vscode.workspace.getConfiguration('localdev-ai').get<string>('selectedModel', '').trim();
      if (!model) {
        void vscode.window.showErrorMessage('No Ollama model is selected. Use “LocalDev AI: Select Ollama Model” first.');
        return;
      }
      if (!engine) {
        void vscode.window.showErrorMessage('The LocalDev AI engine is not running. Reload the extension and retry.');
        return;
      }
      try {
        const response = await engine.request('explain_traceback', {
          ...ollamaOptions(),
          model,
          traceback,
        });
        if (!response || typeof response.message !== 'string') {
          throw new Error('The engine returned an empty traceback explanation.');
        }
        const output = vscode.window.createOutputChannel('LocalDev AI Traceback Explanation');
        output.clear();
        output.appendLine(response.message);
        output.show(true);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const proposePatch = vscode.commands.registerCommand(
    'localdev-ai.proposePatch',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        void vscode.window.showInformationMessage('Open a Python file before requesting a patch.');
        return;
      }
      const raw = await vscode.window.showInputBox({
        prompt: 'Paste the Python traceback for this patch',
        ignoreFocusOut: true,
      });
      if (raw === undefined) return;
      const traceback = parsePythonTraceback(raw);
      if (!traceback) {
        void vscode.window.showErrorMessage('The input is not a valid Python traceback.');
        return;
      }
      const model = vscode.workspace.getConfiguration('localdev-ai').get<string>('selectedModel', '').trim();
      if (!model) {
        void vscode.window.showErrorMessage('No Ollama model is selected. Use “LocalDev AI: Select Ollama Model” first.');
        return;
      }
      if (!engine) {
        void vscode.window.showErrorMessage('The LocalDev AI engine is not running. Reload the extension and retry.');
        return;
      }
      try {
        const documentUri = editor.document.uri;
        const documentVersion = editor.document.version;
        const original = editor.document.getText();
        const response = await engine.request('propose_patch', {
          ...ollamaOptions(),
          model,
          code: original,
          traceback,
        });
        if (!response || typeof response.message !== 'string') {
          throw new Error('The engine returned an empty patch proposal.');
        }
        const proposed = proposedSource(response.message, original);
        if (proposed === undefined) {
          throw new Error('The engine returned an invalid unified diff.');
        }
        const preview = await vscode.workspace.openTextDocument({
          content: proposed,
          language: 'python',
        });
        await vscode.commands.executeCommand(
          'vscode.diff',
          editor.document.uri,
          preview.uri,
          'LocalDev AI Patch Proposal',
        );
        const apply = 'Apply';
        const reject = 'Reject';
        const choice = await vscode.window.showInformationMessage(
          'Apply this patch to the active Python file?',
          { modal: true },
          apply,
          reject,
        );
        if (choice === apply && editor.document.uri.toString() === documentUri.toString()
          && editor.document.version === documentVersion) {
          const edit = new vscode.WorkspaceEdit();
          const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
          edit.replace(
            documentUri,
            new vscode.Range(0, 0, editor.document.lineCount - 1, lastLine.text.length),
            proposed,
          );
          if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error('VS Code rejected the patch application.');
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
  );

  const chatProvider = new ChatViewProvider(context.extensionUri, () => engine);
  const chatViewDisposable = vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewType,
    chatProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const openChat = vscode.commands.registerCommand('localdev-ai.openChat', async () => {
    await vscode.commands.executeCommand('localdev-ai.chatView.focus');
  });

  const newChat = vscode.commands.registerCommand('localdev-ai.newChat', async () => {
    await vscode.commands.executeCommand('localdev-ai.chatView.focus');
  });

  context.subscriptions.push(
    disposable,
    refreshModels,
    checkHardware,
    selectModel,
    explainCode,
    explainTraceback,
    proposePatch,
    chatViewDisposable,
    openChat,
    newChat,
  );
}

function formatBytes(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export async function deactivate(): Promise<void> {
  await engine?.stop();
  engine = undefined;
}
