import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonEngine } from './pythonEngine';

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

function ollamaOptions(): Record<string, unknown> {
  const configuration = vscode.workspace.getConfiguration('localdev-ai');
  return {
    ollama_endpoint: configuration.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
    ollama_timeout_seconds: configuration.get<number>('ollamaTimeoutSeconds', 5),
  };
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

  context.subscriptions.push(disposable, refreshModels, selectModel, explainCode);
}

export async function deactivate(): Promise<void> {
  await engine?.stop();
  engine = undefined;
}
