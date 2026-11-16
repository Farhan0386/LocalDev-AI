import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonEngine } from './pythonEngine';
import { applyUnifiedDiff } from './diffUtils';
import {
  buildWorkspaceContext,
  getActiveEditorContext,
  searchWorkspaceFiles,
  WorkspaceContextData,
} from './workspaceContext';

export interface CrudAction {
  id: string;
  action: 'create' | 'update' | 'delete' | 'read';
  path: string;
  explanation?: string;
  content?: string;
  diff?: string;
  status: 'pending' | 'applied' | 'rejected' | 'failed';
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  crudActions?: CrudAction[];
}

export interface OnboardingState {
  state: 'checking' | 'ollama_offline' | 'no_models' | 'ready';
  error?: Record<string, unknown>;
  hardware?: Record<string, unknown>;
  recommendation?: { model: string; reason: string; fit: string };
  models?: Array<Record<string, unknown>>;
  selectedModel?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localdev-ai.chatView';

  private _view?: vscode.WebviewView;
  private _engine?: PythonEngine;
  private _messages: ChatMessage[] = [];
  private _mode: 'learn' | 'edit' = 'learn';
  private _isStreaming = false;
  private _cancellationSource?: vscode.CancellationTokenSource;
  private _activeFiles: string[] = [];
  private _includeWorkspace = false;
  private _onboardingState: OnboardingState = { state: 'checking' };
  private _installedModels: string[] = [];
  private _selectedModel = '';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    engineGetter: () => PythonEngine | undefined,
  ) {
    this._getEngine = engineGetter;
  }

  private _getEngine: () => PythonEngine | undefined;

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this._handleWebviewMessage(message);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshDiagnostics();
      }
    });

    // Run initial setup and diagnostics check
    void this.refreshDiagnostics();
  }

  public async refreshDiagnostics(): Promise<void> {
    const engine = this._getEngine();
    if (!engine) {
      this._updateOnboarding({
        state: 'ollama_offline',
        error: { message: 'Python engine is starting or not ready.' },
      });
      return;
    }

    try {
      const config = vscode.workspace.getConfiguration('localdev-ai');
      const endpoint = config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
      const timeout = config.get<number>('ollamaTimeoutSeconds', 5);
      const selected = config.get<string>('selectedModel', '');

      const diagResponse = await engine.request('hardware_diagnostics', {
        ollama_endpoint: endpoint,
        ollama_timeout_seconds: timeout,
      });

      const message = (diagResponse.message || {}) as Record<string, unknown>;
      const hardware = (message.hardware || {}) as Record<string, unknown>;
      const models = Array.isArray(message.models) ? (message.models as Array<Record<string, unknown>>) : [];
      const recommendation = message.recommendation as { model: string; reason: string; fit: string } | undefined;
      const ollamaError = message.ollama_error as Record<string, unknown> | undefined;

      this._installedModels = models
        .map((m) => (typeof m.name === 'string' ? m.name : ''))
        .filter(Boolean);

      this._selectedModel = selected || (this._installedModels.length > 0 ? this._installedModels[0] : '');

      if (ollamaError) {
        this._updateOnboarding({
          state: 'ollama_offline',
          error: ollamaError,
          hardware,
          recommendation,
        });
      } else if (this._installedModels.length === 0) {
        this._updateOnboarding({
          state: 'no_models',
          hardware,
          recommendation,
          models,
        });
      } else {
        this._updateOnboarding({
          state: 'ready',
          hardware,
          recommendation,
          models,
          selectedModel: this._selectedModel,
        });
      }
    } catch (error) {
      this._updateOnboarding({
        state: 'ollama_offline',
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private _updateOnboarding(state: OnboardingState): void {
    this._onboardingState = state;
    this._postMessage({
      type: 'onboardingState',
      state,
      installedModels: this._installedModels,
      selectedModel: this._selectedModel,
    });
  }

  private async _handleWebviewMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready': {
        await this.refreshDiagnostics();
        this._syncEditorContext();
        break;
      }

      case 'sendMessage': {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (text) {
          await this._sendUserMessage(text);
        }
        break;
      }

      case 'cancelStream': {
        this._cancelStreaming();
        break;
      }

      case 'setMode': {
        if (message.mode === 'learn' || message.mode === 'edit') {
          this._mode = message.mode;
          this._postMessage({ type: 'modeChanged', mode: this._mode });
        }
        break;
      }

      case 'selectModel': {
        const model = typeof message.model === 'string' ? message.model : '';
        if (model) {
          await this._selectModel(model);
        }
        break;
      }

      case 'refreshModels': {
        await this.refreshDiagnostics();
        break;
      }

      case 'startOllama': {
        this._startOllamaService();
        break;
      }

      case 'installOllama': {
        this._installOllamaGuide();
        break;
      }

      case 'pullModel': {
        const modelName = typeof message.model === 'string' ? message.model : this._onboardingState.recommendation?.model;
        if (modelName) {
          await this._pullModel(modelName);
        }
        break;
      }

      case 'applyCrudAction': {
        const actionId = typeof message.id === 'string' ? message.id : '';
        if (actionId) {
          await this._executeCrudAction(actionId, true);
        }
        break;
      }

      case 'rejectCrudAction': {
        const actionId = typeof message.id === 'string' ? message.id : '';
        if (actionId) {
          await this._executeCrudAction(actionId, false);
        }
        break;
      }

      case 'insertCode': {
        const code = typeof message.code === 'string' ? message.code : '';
        if (code) {
          await this._insertCodeAtCursor(code);
        }
        break;
      }

      case 'pickFileContext': {
        await this._pickFileForContext();
        break;
      }

      case 'removeFileContext': {
        const target = typeof message.path === 'string' ? message.path : '';
        this._activeFiles = this._activeFiles.filter((f) => f !== target);
        this._postMessage({ type: 'contextUpdated', activeFiles: this._activeFiles });
        break;
      }

      case 'toggleWorkspaceContext': {
        this._includeWorkspace = !this._includeWorkspace;
        this._postMessage({ type: 'workspaceToggled', enabled: this._includeWorkspace });
        break;
      }

      case 'clearChat': {
        this._messages = [];
        this._postMessage({ type: 'chatCleared' });
        break;
      }

      case 'searchFiles': {
        const query = typeof message.query === 'string' ? message.query : '';
        const results = await searchWorkspaceFiles(query);
        this._postMessage({ type: 'fileSearchResults', results });
        break;
      }
    }
  }

  private _syncEditorContext(): void {
    const editorCtx = getActiveEditorContext();
    this._postMessage({
      type: 'activeEditorChanged',
      editor: editorCtx
        ? {
            path: editorCtx.path,
            lineRange: editorCtx.lineRange,
            language: editorCtx.language,
          }
        : null,
    });
  }

  private async _selectModel(model: string): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('localdev-ai');
      await config.update('selectedModel', model, vscode.ConfigurationTarget.Global);
      this._selectedModel = model;
      const engine = this._getEngine();
      if (engine) {
        await engine.request('select_model', {
          ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
          ollama_timeout_seconds: config.get<number>('ollamaTimeoutSeconds', 5),
          model,
        });
      }
      this._postMessage({ type: 'modelSelected', model });
      void vscode.window.showInformationMessage(`LocalDev AI: Selected model "${model}"`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private _startOllamaService(): void {
    const terminal = vscode.window.createTerminal('Ollama Server');
    terminal.show();
    terminal.sendText('ollama serve');
    void vscode.window.showInformationMessage('Starting Ollama in integrated terminal...');
    setTimeout(() => {
      void this.refreshDiagnostics();
    }, 2500);
  }

  private _installOllamaGuide(): void {
    const terminal = vscode.window.createTerminal('Install Ollama');
    terminal.show();
    if (process.platform === 'win32') {
      terminal.sendText('winget install Ollama.Ollama');
    } else if (process.platform === 'darwin') {
      terminal.sendText('brew install ollama');
    } else {
      terminal.sendText('curl -fsSL https://ollama.com/install.sh | sh');
    }
    void vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
  }

  private async _pullModel(modelName: string): Promise<void> {
    const engine = this._getEngine();
    if (!engine) {
      void vscode.window.showErrorMessage('LocalDev AI engine is not running.');
      return;
    }

    const config = vscode.workspace.getConfiguration('localdev-ai');
    this._postMessage({ type: 'pullStarted', model: modelName });

    try {
      await engine.request(
        'pull_model',
        {
          ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
          ollama_timeout_seconds: 300,
          model: modelName,
        },
        (event) => {
          this._postMessage({ type: 'pullProgress', model: modelName, text: event.text });
        },
      );

      this._postMessage({ type: 'pullCompleted', model: modelName });
      void vscode.window.showInformationMessage(`LocalDev AI: Model "${modelName}" downloaded successfully!`);
      await this._selectModel(modelName);
      await this.refreshDiagnostics();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this._postMessage({ type: 'pullFailed', model: modelName, error: msg });
      void vscode.window.showErrorMessage(`Failed to pull model: ${msg}`);
    }
  }

  private async _pickFileForContext(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Add to Context',
    });

    if (uris && uris.length > 0) {
      for (const uri of uris) {
        const relative = vscode.workspace.asRelativePath(uri);
        if (!this._activeFiles.includes(relative)) {
          this._activeFiles.push(relative);
        }
      }
      this._postMessage({ type: 'contextUpdated', activeFiles: this._activeFiles });
    }
  }

  private async _insertCodeAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('No active editor to insert code into.');
      return;
    }

    await editor.edit((editBuilder) => {
      if (!editor.selection.isEmpty) {
        editBuilder.replace(editor.selection, code);
      } else {
        editBuilder.insert(editor.selection.active, code);
      }
    });
    void vscode.window.showInformationMessage('Code inserted into active editor.');
  }

  private async _sendUserMessage(userPrompt: string): Promise<void> {
    const engine = this._getEngine();
    if (!engine) {
      void vscode.window.showErrorMessage('The LocalDev AI engine is not running.');
      return;
    }

    if (!this._selectedModel) {
      void vscode.window.showWarningMessage('No Ollama model selected. Please select or pull a model first.');
      return;
    }

    // Add user message to history
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userPrompt,
      timestamp: Date.now(),
    };
    this._messages.push(userMsg);

    const assistantMsgId = `assistant-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      crudActions: [],
    };
    this._messages.push(assistantMsg);

    this._isStreaming = true;
    this._cancellationSource = new vscode.CancellationTokenSource();

    this._postMessage({
      type: 'messageAdded',
      message: userMsg,
    });
    this._postMessage({
      type: 'streamStarted',
      id: assistantMsgId,
      role: 'assistant',
    });

    try {
      const workspaceContext = await buildWorkspaceContext(userPrompt, {
        includeWorkspaceTree: this._includeWorkspace,
        explicitFilePaths: this._activeFiles,
        includeActiveEditor: true,
      });

      const config = vscode.workspace.getConfiguration('localdev-ai');
      const messagesPayload = this._messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      let accumulatedContent = '';

      const response = await engine.request(
        'chat_session',
        {
          ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
          ollama_timeout_seconds: config.get<number>('ollamaTimeoutSeconds', 120),
          model: this._selectedModel,
          mode: this._mode,
          messages: messagesPayload,
          workspace_context: workspaceContext,
        },
        (event) => {
          accumulatedContent += event.text;
          assistantMsg.content = accumulatedContent;
          this._postMessage({
            type: 'streamToken',
            id: assistantMsgId,
            text: event.text,
          });
        },
        this._cancellationSource.token,
      );

      const finalText = typeof response.message === 'string' ? response.message : accumulatedContent;
      assistantMsg.content = finalText;

      // Parse structured CRUD actions or unified diffs
      const parsedActions = this._parseCrudActions(finalText);
      assistantMsg.crudActions = parsedActions;

      this._postMessage({
        type: 'streamFinished',
        id: assistantMsgId,
        content: finalText,
        crudActions: parsedActions,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('cancelled')) {
        this._postMessage({
          type: 'streamCancelled',
          id: assistantMsgId,
        });
      } else {
        const errorText = error instanceof Error ? error.message : String(error);
        assistantMsg.content = `⚠️ *Error: ${errorText}*`;
        this._postMessage({
          type: 'streamFinished',
          id: assistantMsgId,
          content: assistantMsg.content,
        });
        void vscode.window.showErrorMessage(`LocalDev AI Chat: ${errorText}`);
      }
    } finally {
      this._isStreaming = false;
      this._cancellationSource?.dispose();
      this._cancellationSource = undefined;
    }
  }

  private _cancelStreaming(): void {
    if (this._isStreaming && this._cancellationSource) {
      this._cancellationSource.cancel();
    }
  }

  private _parseCrudActions(text: string): CrudAction[] {
    const actions: CrudAction[] = [];

    // 1. Look for ```localdev_tool or ```json tool blocks
    const toolRegex = /```(?:localdev_tool|json)\s*\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;
    while ((match = toolRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === 'object') {
          const actionType = String(parsed.action || parsed.tool || '').toLowerCase();
          if (['create', 'update', 'delete', 'read'].includes(actionType)) {
            actions.push({
              id: `crud-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              action: actionType as 'create' | 'update' | 'delete' | 'read',
              path: String(parsed.path || ''),
              explanation: parsed.explanation ? String(parsed.explanation) : undefined,
              content: parsed.content ? String(parsed.content) : undefined,
              diff: parsed.diff ? String(parsed.diff) : undefined,
              status: 'pending',
            });
          }
        }
      } catch {
        // Not valid JSON tool block
      }
    }

    // 2. Look for standalone ```diff blocks that specify file headers
    if (actions.length === 0) {
      const diffRegex = /```diff\s*\n([\s\S]*?)\n```/g;
      while ((match = diffRegex.exec(text)) !== null) {
        const diffBody = match[1];
        const fileMatch = diffBody.match(/^--- (?:a\/)?([^\r\n]+)\r?\n\+\+\+ (?:b\/)?([^\r\n]+)/m);
        if (fileMatch) {
          const targetFile = fileMatch[2].trim();
          actions.push({
            id: `crud-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            action: 'update',
            path: targetFile,
            explanation: `Apply proposed diff to ${targetFile}`,
            diff: diffBody,
            status: 'pending',
          });
        }
      }
    }

    return actions;
  }

  private async _executeCrudAction(actionId: string, approve: boolean): Promise<void> {
    // Locate the action across messages
    let foundAction: CrudAction | undefined;
    for (const msg of this._messages) {
      if (msg.crudActions) {
        foundAction = msg.crudActions.find((a) => a.id === actionId);
        if (foundAction) break;
      }
    }

    if (!foundAction) {
      void vscode.window.showErrorMessage(`Action "${actionId}" not found.`);
      return;
    }

    if (!approve) {
      foundAction.status = 'rejected';
      this._postMessage({
        type: 'crudActionUpdated',
        action: foundAction,
      });
      void vscode.window.showInformationMessage(`Rejected change to ${foundAction.path}`);
      return;
    }

    // Explicit User Approval confirmed -> Perform Workspace FS modification safely
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showErrorMessage('Cannot execute workspace action: No folder is open.');
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const cleanRelative = path.normalize(foundAction.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const targetUri = vscode.Uri.joinPath(rootUri, cleanRelative);

    // Security check: ensure target does not escape workspace folder
    if (!targetUri.fsPath.startsWith(rootUri.fsPath)) {
      foundAction.status = 'failed';
      foundAction.error = 'Security violation: Path is outside workspace.';
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
      void vscode.window.showErrorMessage(foundAction.error);
      return;
    }

    try {
      if (foundAction.action === 'create') {
        const content = foundAction.content || '';
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf-8'));
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
        foundAction.status = 'applied';
        void vscode.window.showInformationMessage(`Created file: ${foundAction.path}`);
      } else if (foundAction.action === 'update') {
        if (foundAction.diff) {
          const originalBytes = await vscode.workspace.fs.readFile(targetUri);
          const originalText = Buffer.from(originalBytes).toString('utf-8');
          const patched = applyUnifiedDiff(foundAction.diff, originalText);
          if (patched === undefined) {
            throw new Error('Diff could not be applied cleanly to existing file content.');
          }
          await vscode.workspace.fs.writeFile(targetUri, Buffer.from(patched, 'utf-8'));
        } else if (foundAction.content !== undefined) {
          await vscode.workspace.fs.writeFile(targetUri, Buffer.from(foundAction.content, 'utf-8'));
        } else {
          throw new Error('No content or diff provided for update.');
        }
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
        foundAction.status = 'applied';
        void vscode.window.showInformationMessage(`Applied update to: ${foundAction.path}`);
      } else if (foundAction.action === 'delete') {
        await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
        foundAction.status = 'applied';
        void vscode.window.showInformationMessage(`Deleted file: ${foundAction.path}`);
      } else if (foundAction.action === 'read') {
        const bytes = await vscode.workspace.fs.readFile(targetUri);
        const text = Buffer.from(bytes).toString('utf-8');
        foundAction.status = 'applied';
        await this._sendUserMessage(`Here is the content of @${foundAction.path}:\n\`\`\`\n${text}\n\`\`\``);
      }

      this._postMessage({
        type: 'crudActionUpdated',
        action: foundAction,
      });
    } catch (err) {
      foundAction.status = 'failed';
      foundAction.error = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
      void vscode.window.showErrorMessage(`Action failed: ${foundAction.error}`);
    }
  }

  private _postMessage(message: unknown): void {
    if (this._view) {
      void this._view.webview.postMessage(message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <title>LocalDev AI</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #181818);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --input-bg: var(--vscode-input-background, #252526);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --card-bg: var(--vscode-editorWidget-background, #1f1f1f);
      --card-border: var(--vscode-widget-border, #333333);
      --code-bg: var(--vscode-textCodeBlock-background, #141414);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --success: #388a34;
      --danger: #d73a49;
      --accent: #58a6ff;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top Bar */
    #top-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      font-size: 11px;
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 10px;
      background: rgba(255,255,255,0.06);
      font-weight: 500;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #888;
    }
    .status-dot.online { background: #4caf50; box-shadow: 0 0 5px #4caf50; }
    .status-dot.offline { background: #f44336; }

    .fit-badge {
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent);
      font-size: 10px;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .model-selector-wrap {
      display: flex;
      align-items: center;
      margin-left: auto;
      gap: 4px;
    }

    select.model-select {
      background: var(--input-bg);
      color: var(--fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px;
      outline: none;
      max-width: 140px;
    }

    button.icon-btn {
      background: transparent;
      color: var(--fg);
      border: none;
      cursor: pointer;
      padding: 3px 5px;
      border-radius: 3px;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button.icon-btn:hover { background: rgba(255,255,255,0.1); }

    /* Onboarding Card */
    #onboarding-container {
      margin: 10px;
      padding: 12px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .onboarding-title {
      font-weight: 600;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .onboarding-desc {
      font-size: 12px;
      line-height: 1.4;
      opacity: 0.9;
    }
    .onboarding-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn.btn-secondary {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--fg);
    }
    .btn.btn-secondary:hover { background: rgba(255,255,255,0.08); }
    .btn.btn-success { background: #238636; color: #fff; }
    .btn.btn-success:hover { background: #2ea043; }
    .btn.btn-danger { background: #da3633; color: #fff; }
    .btn.btn-danger:hover { background: #f85149; }

    /* Progress bar */
    .progress-bar {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 4px;
      display: none;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s ease;
    }

    /* Main Chat Stream */
    #chat-stream {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .chat-message {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-width: 100%;
      animation: fadeIn 0.2s ease-in-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .chat-bubble {
      padding: 8px 12px;
      border-radius: 6px;
      line-height: 1.5;
      word-break: break-word;
      font-size: 12px;
    }

    .user-message .chat-bubble {
      background: rgba(88, 166, 255, 0.12);
      border: 1px solid rgba(88, 166, 255, 0.25);
      align-self: flex-end;
    }

    .assistant-message .chat-bubble {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      align-self: flex-start;
      width: 100%;
    }

    .msg-header {
      font-size: 10px;
      color: rgba(255,255,255,0.5);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Code Blocks */
    .code-container {
      margin: 8px 0;
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      overflow: hidden;
      font-family: var(--vscode-editor-font-family, Consolas, Monaco, monospace);
    }

    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 8px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 10px;
      color: rgba(255,255,255,0.6);
    }

    .code-actions {
      display: flex;
      gap: 4px;
    }

    .code-btn {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.1);
      color: var(--fg);
      border-radius: 3px;
      font-size: 9px;
      padding: 1px 5px;
      cursor: pointer;
    }
    .code-btn:hover { background: rgba(255,255,255,0.1); }

    pre code {
      display: block;
      padding: 8px;
      overflow-x: auto;
      font-size: 11px;
      line-height: 1.4;
    }

    /* Diff / CRUD Confirmation Card */
    .crud-card {
      margin: 10px 0;
      border: 1px solid var(--card-border);
      border-left: 3px solid var(--accent);
      background: rgba(0,0,0,0.25);
      border-radius: 4px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .crud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .crud-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      background: var(--accent);
      color: #fff;
    }
    .crud-badge.create { background: #2ea043; }
    .crud-badge.update { background: #0969da; }
    .crud-badge.delete { background: #cf222e; }

    .crud-path {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 11px;
      color: #e6edf3;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .crud-diff-preview {
      background: var(--code-bg);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 3px;
      padding: 6px;
      max-height: 180px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 11px;
      line-height: 1.35;
      white-space: pre-wrap;
    }

    .diff-line-add { color: #56d364; background: rgba(46, 160, 67, 0.15); display: block; }
    .diff-line-del { color: #f85149; background: rgba(248, 81, 73, 0.15); display: block; }
    .diff-line-info { color: #79c0ff; display: block; }

    .crud-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
    }

    .status-text {
      font-size: 11px;
      font-weight: 500;
    }
    .status-text.applied { color: #56d364; }
    .status-text.rejected { color: #8b949e; }
    .status-text.failed { color: #f85149; }

    /* Bottom Input Bar */
    #bottom-bar {
      padding: 8px 10px;
      background: var(--card-bg);
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .context-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 10px;
    }

    .chip {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 2px 8px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .chip:hover { background: rgba(255,255,255,0.12); }
    .chip.active { background: rgba(88, 166, 255, 0.2); border-color: var(--accent); color: var(--accent); }
    .chip .chip-remove { font-weight: bold; cursor: pointer; }

    .mode-toggle {
      margin-left: auto;
      display: flex;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      font-size: 10px;
    }
    .mode-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      padding: 2px 7px;
      cursor: pointer;
      font-size: 10px;
    }
    .mode-btn.active {
      background: var(--btn-bg);
      color: #fff;
      font-weight: 600;
    }

    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 4px 6px;
    }

    textarea#prompt-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--fg);
      font-family: inherit;
      font-size: 12px;
      resize: none;
      max-height: 120px;
      min-height: 24px;
      line-height: 1.4;
    }

    #send-btn, #stop-btn {
      padding: 4px 8px;
      font-size: 11px;
    }
    #stop-btn { display: none; background: #da3633; }
  </style>
</head>
<body>
  <!-- Top Bar -->
  <div id="top-bar">
    <div class="status-pill" title="Ollama Status">
      <div id="status-dot" class="status-dot"></div>
      <span id="status-text">Ollama Checking</span>
    </div>
    <div id="fit-badge" class="fit-badge" style="display:none;">Fit: Checking</div>
    <div class="model-selector-wrap">
      <select id="model-select" class="model-select" title="Active Model">
        <option value="">No model</option>
      </select>
      <button id="refresh-models-btn" class="icon-btn" title="Refresh Models">↻</button>
      <button id="clear-chat-btn" class="icon-btn" title="Clear Chat History">🗑</button>
    </div>
  </div>

  <!-- Onboarding & Setup Card -->
  <div id="onboarding-container">
    <div class="onboarding-title">
      <span id="onboarding-icon">🚀</span>
      <span id="onboarding-header">Welcome to LocalDev AI</span>
    </div>
    <div id="onboarding-desc" class="onboarding-desc">
      Setting up your private, local coding assistant...
    </div>
    <div id="onboarding-actions" class="onboarding-actions"></div>
    <div id="pull-progress-bar" class="progress-bar">
      <div id="pull-progress-fill" class="progress-fill"></div>
    </div>
  </div>

  <!-- Chat Stream -->
  <div id="chat-stream">
    <div id="welcome-msg" class="chat-message assistant-message">
      <div class="msg-header">LocalDev AI</div>
      <div class="chat-bubble">
        👋 Hi! I am your local-first coding assistant and mentor.
        <br><br>
        • <strong>Ask / Learn mode:</strong> I will explain concepts and guide you step-by-step.
        <br>
        • <strong>Edit / CRUD mode:</strong> I can propose workspace edits and file creations (which you can review and apply with 1 click).
      </div>
    </div>
  </div>

  <!-- Bottom Input Bar -->
  <div id="bottom-bar">
    <div class="context-bar">
      <span id="active-file-chip" class="chip" style="display:none;">
        <span id="active-file-label">📄 file</span>
      </span>
      <button id="attach-file-btn" class="chip" title="Attach file to context">+ @file</button>
      <button id="toggle-workspace-btn" class="chip" title="Include directory outline">+ @workspace</button>
      
      <div class="mode-toggle">
        <button id="mode-learn-btn" class="mode-btn active" title="Learn & Explain mode">💡 Learn</button>
        <button id="mode-edit-btn" class="mode-btn" title="Edit & CRUD mode">🛠 Edit</button>
      </div>
    </div>

    <div class="input-row">
      <textarea id="prompt-input" rows="1" placeholder="Ask a question or type @filename..."></textarea>
      <button id="send-btn" class="btn">Send</button>
      <button id="stop-btn" class="btn">Stop</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // DOM Elements
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const fitBadge = document.getElementById('fit-badge');
    const modelSelect = document.getElementById('model-select');
    const refreshModelsBtn = document.getElementById('refresh-models-btn');
    const clearChatBtn = document.getElementById('clear-chat-btn');
    const onboardingContainer = document.getElementById('onboarding-container');
    const onboardingHeader = document.getElementById('onboarding-header');
    const onboardingDesc = document.getElementById('onboarding-desc');
    const onboardingActions = document.getElementById('onboarding-actions');
    const progressBar = document.getElementById('pull-progress-bar');
    const progressFill = document.getElementById('pull-progress-fill');
    const chatStream = document.getElementById('chat-stream');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const activeFileChip = document.getElementById('active-file-chip');
    const activeFileLabel = document.getElementById('active-file-label');
    const attachFileBtn = document.getElementById('attach-file-btn');
    const toggleWorkspaceBtn = document.getElementById('toggle-workspace-btn');
    const modeLearnBtn = document.getElementById('mode-learn-btn');
    const modeEditBtn = document.getElementById('mode-edit-btn');

    let currentMode = 'learn';
    let currentStreamingMsgEl = null;

    // Send ready notification
    vscode.postMessage({ type: 'ready' });

    // Handle incoming messages
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'onboardingState':
          renderOnboarding(msg.state, msg.installedModels, msg.selectedModel);
          break;
        case 'pullProgress':
          updatePullProgress(msg.text);
          break;
        case 'pullCompleted':
          hideProgressBar();
          break;
        case 'messageAdded':
          appendMessage(msg.message);
          break;
        case 'streamStarted':
          startStream(msg.id, msg.role);
          break;
        case 'streamToken':
          appendStreamToken(msg.id, msg.text);
          break;
        case 'streamFinished':
          finishStream(msg.id, msg.content, msg.crudActions);
          break;
        case 'streamCancelled':
          cancelStream(msg.id);
          break;
        case 'crudActionUpdated':
          updateCrudCard(msg.action);
          break;
        case 'activeEditorChanged':
          updateEditorContext(msg.editor);
          break;
        case 'contextUpdated':
          updateContextChips(msg.activeFiles);
          break;
        case 'workspaceToggled':
          toggleWorkspaceBtn.classList.toggle('active', msg.enabled);
          break;
        case 'chatCleared':
          chatStream.innerHTML = '';
          break;
      }
    });

    // Top Bar Actions
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value) {
        vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
      }
    });

    refreshModelsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });

    clearChatBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearChat' });
    });

    // Mode Toggle
    modeLearnBtn.addEventListener('click', () => {
      currentMode = 'learn';
      modeLearnBtn.classList.add('active');
      modeEditBtn.classList.remove('active');
      vscode.postMessage({ type: 'setMode', mode: 'learn' });
    });

    modeEditBtn.addEventListener('click', () => {
      currentMode = 'edit';
      modeEditBtn.classList.add('active');
      modeLearnBtn.classList.remove('active');
      vscode.postMessage({ type: 'setMode', mode: 'edit' });
    });

    // Input & Send
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    sendBtn.addEventListener('click', submitPrompt);

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelStream' });
    });

    attachFileBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'pickFileContext' });
    });

    toggleWorkspaceBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggleWorkspaceContext' });
    });

    function submitPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    // Onboarding UI Rendering
    function renderOnboarding(state, models, selectedModel) {
      // Update models dropdown
      modelSelect.innerHTML = '';
      if (models && models.length > 0) {
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === selectedModel) opt.selected = true;
          modelSelect.appendChild(opt);
        });
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models';
        modelSelect.appendChild(opt);
      }

      onboardingActions.innerHTML = '';

      if (state.state === 'ollama_offline') {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Ollama Offline';
        fitBadge.style.display = 'none';

        onboardingContainer.style.display = 'flex';
        onboardingHeader.textContent = 'Ollama Not Running';
        onboardingDesc.textContent = state.error?.message || 'Ollama is not reachable on your machine. LocalDev AI requires Ollama to run models completely locally and privately.';

        const startBtn = document.createElement('button');
        startBtn.className = 'btn btn-success';
        startBtn.textContent = '▶ Start Ollama';
        startBtn.onclick = () => vscode.postMessage({ type: 'startOllama' });

        const installBtn = document.createElement('button');
        installBtn.className = 'btn btn-secondary';
        installBtn.textContent = '📥 Install Ollama';
        installBtn.onclick = () => vscode.postMessage({ type: 'installOllama' });

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-secondary';
        retryBtn.textContent = '↻ Retry';
        retryBtn.onclick = () => vscode.postMessage({ type: 'refreshModels' });

        onboardingActions.appendChild(startBtn);
        onboardingActions.appendChild(installBtn);
        onboardingActions.appendChild(retryBtn);
      } else if (state.state === 'no_models') {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Ollama Online';
        onboardingContainer.style.display = 'flex';

        const rec = state.recommendation || { model: 'qwen2.5-coder:1.5b', reason: 'Balanced model for local hardware', fit: 'Comfortable' };
        fitBadge.style.display = 'inline-block';
        fitBadge.textContent = 'Fit: ' + rec.fit;

        onboardingHeader.textContent = 'Download Recommended Model';
        onboardingDesc.textContent = rec.reason + ' Recommended: ' + rec.model;

        const pullBtn = document.createElement('button');
        pullBtn.className = 'btn btn-success';
        pullBtn.textContent = '⬇ Pull ' + rec.model;
        pullBtn.onclick = () => {
          progressBar.style.display = 'block';
          vscode.postMessage({ type: 'pullModel', model: rec.model });
        };

        onboardingActions.appendChild(pullBtn);
      } else {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Ollama Online';
        onboardingContainer.style.display = 'none';

        if (state.recommendation) {
          fitBadge.style.display = 'inline-block';
          fitBadge.textContent = 'Fit: ' + state.recommendation.fit;
        }
      }
    }

    function updatePullProgress(text) {
      progressBar.style.display = 'block';
      onboardingDesc.textContent = text;
      const match = text.match(/(\\d+)%/);
      if (match) {
        progressFill.style.width = match[1] + '%';
      }
    }

    function hideProgressBar() {
      progressBar.style.display = 'none';
      progressFill.style.width = '0%';
    }

    function updateEditorContext(editor) {
      if (editor) {
        activeFileChip.style.display = 'inline-flex';
        activeFileLabel.textContent = '📄 ' + editor.path + (editor.lineRange ? ' (' + editor.lineRange + ')' : '');
      } else {
        activeFileChip.style.display = 'none';
      }
    }

    function updateContextChips(files) {
      // Remove previous extra chips
      document.querySelectorAll('.attached-file-chip').forEach(el => el.remove());
      if (files && files.length > 0) {
        files.forEach(f => {
          const chip = document.createElement('span');
          chip.className = 'chip attached-file-chip';
          chip.innerHTML = '📎 ' + f + ' <span class="chip-remove">×</span>';
          chip.querySelector('.chip-remove').onclick = () => {
            vscode.postMessage({ type: 'removeFileContext', path: f });
          };
          attachFileBtn.parentNode.insertBefore(chip, attachFileBtn);
        });
      }
    }

    // Message Rendering
    function appendMessage(msg) {
      const msgEl = document.createElement('div');
      msgEl.id = msg.id;
      msgEl.className = 'chat-message ' + (msg.role === 'user' ? 'user-message' : 'assistant-message');
      
      const header = document.createElement('div');
      header.className = 'msg-header';
      header.textContent = msg.role === 'user' ? 'You' : 'LocalDev AI';
      
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.innerHTML = renderMarkdown(msg.content);

      msgEl.appendChild(header);
      msgEl.appendChild(bubble);
      chatStream.appendChild(msgEl);
      chatStream.scrollTop = chatStream.scrollHeight;
    }

    function startStream(id, role) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'inline-block';

      const msgEl = document.createElement('div');
      msgEl.id = id;
      msgEl.className = 'chat-message assistant-message';

      const header = document.createElement('div');
      header.className = 'msg-header';
      header.textContent = 'LocalDev AI';

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.innerHTML = '<span class="streaming-cursor">▋</span>';

      msgEl.appendChild(header);
      msgEl.appendChild(bubble);
      chatStream.appendChild(msgEl);
      chatStream.scrollTop = chatStream.scrollHeight;

      currentStreamingMsgEl = msgEl;
    }

    let streamBuffer = '';
    function appendStreamToken(id, text) {
      streamBuffer += text;
      if (currentStreamingMsgEl) {
        const bubble = currentStreamingMsgEl.querySelector('.chat-bubble');
        if (bubble) {
          bubble.innerHTML = renderMarkdown(streamBuffer) + ' <span class="streaming-cursor">▋</span>';
          attachCodeButtons(bubble);
        }
        chatStream.scrollTop = chatStream.scrollHeight;
      }
    }

    function finishStream(id, content, crudActions) {
      sendBtn.style.display = 'inline-block';
      stopBtn.style.display = 'none';
      streamBuffer = '';

      if (currentStreamingMsgEl) {
        const bubble = currentStreamingMsgEl.querySelector('.chat-bubble');
        if (bubble) {
          bubble.innerHTML = renderMarkdown(content);
          attachCodeButtons(bubble);

          // Render any parsed CRUD confirmation cards
          if (crudActions && crudActions.length > 0) {
            crudActions.forEach(action => {
              bubble.appendChild(createCrudCardElement(action));
            });
          }
        }
      }
      currentStreamingMsgEl = null;
      chatStream.scrollTop = chatStream.scrollHeight;
    }

    function cancelStream(id) {
      sendBtn.style.display = 'inline-block';
      stopBtn.style.display = 'none';
      streamBuffer = '';
      if (currentStreamingMsgEl) {
        const bubble = currentStreamingMsgEl.querySelector('.chat-bubble');
        if (bubble) {
          bubble.innerHTML += '<br><em>(Request cancelled)</em>';
        }
      }
      currentStreamingMsgEl = null;
    }

    // Markdown & Code Rendering
    function renderMarkdown(text) {
      if (!text) return '';
      // Escape basic HTML
      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Fenced code blocks
      const tripleB = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
      const codeBlockRegex = new RegExp(tripleB + '([a-zA-Z0-9_\\\\-]+)?\\\\s*\\\\n([\\\\s\\\\S]*?)\\\\n' + tripleB, 'g');
      html = html.replace(codeBlockRegex, (match, lang, code) => {
        const language = lang || 'code';
        return '<div class="code-container">' +
               '<div class="code-header">' +
               '<span>' + language + '</span>' +
               '<div class="code-actions">' +
               '<button class="code-btn copy-btn" data-code="' + encodeURIComponent(code) + '">Copy</button>' +
               '<button class="code-btn insert-btn" data-code="' + encodeURIComponent(code) + '">Insert at Cursor</button>' +
               '</div></div>' +
               '<pre><code>' + code + '</code></pre>' +
               '</div>';
      });

      // Inline code
      const inlineCodeRegex = new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g');
      html = html.replace(inlineCodeRegex, '<code>$1</code>');
      // Bold
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      // Italic
      html = html.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');
      // Headers
      html = html.replace(/^### (.*)$/gm, '<h4 style="margin:6px 0 2px">$1</h4>');
      html = html.replace(/^## (.*)$/gm, '<h3 style="margin:8px 0 3px">$1</h3>');
      html = html.replace(/^# (.*)$/gm, '<h2 style="margin:10px 0 4px">$1</h2>');
      // Line breaks
      html = html.replace(/\\n/g, '<br>');

      return html;
    }

    function attachCodeButtons(container) {
      container.querySelectorAll('.copy-btn').forEach(btn => {
        btn.onclick = () => {
          const code = decodeURIComponent(btn.getAttribute('data-code') || '');
          navigator.clipboard.writeText(code);
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        };
      });

      container.querySelectorAll('.insert-btn').forEach(btn => {
        btn.onclick = () => {
          const code = decodeURIComponent(btn.getAttribute('data-code') || '');
          vscode.postMessage({ type: 'insertCode', code });
        };
      });
    }

    // Interactive CRUD Card Creation
    function createCrudCardElement(action) {
      const card = document.createElement('div');
      card.id = action.id;
      card.className = 'crud-card';

      const header = document.createElement('div');
      header.className = 'crud-header';

      const badge = document.createElement('span');
      badge.className = 'crud-badge ' + action.action;
      badge.textContent = action.action.toUpperCase();

      const pathSpan = document.createElement('span');
      pathSpan.className = 'crud-path';
      pathSpan.textContent = action.path;

      header.appendChild(badge);
      header.appendChild(pathSpan);
      card.appendChild(header);

      if (action.explanation) {
        const exp = document.createElement('div');
        exp.style.fontSize = '11px';
        exp.style.color = '#8b949e';
        exp.textContent = action.explanation;
        card.appendChild(exp);
      }

      // Preview (Diff or Content)
      if (action.diff) {
        const preview = document.createElement('div');
        preview.className = 'crud-diff-preview';
        const lines = action.diff.split('\\n');
        preview.innerHTML = lines.map(line => {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            return '<span class="diff-line-add">' + escapeHtml(line) + '</span>';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            return '<span class="diff-line-del">' + escapeHtml(line) + '</span>';
          } else if (line.startsWith('@@')) {
            return '<span class="diff-line-info">' + escapeHtml(line) + '</span>';
          }
          return escapeHtml(line);
        }).join('\\n');
        card.appendChild(preview);
      } else if (action.content) {
        const preview = document.createElement('div');
        preview.className = 'crud-diff-preview';
        preview.textContent = action.content.slice(0, 300) + (action.content.length > 300 ? '\\n...' : '');
        card.appendChild(preview);
      }

      // Action buttons
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'crud-actions';

      if (action.status === 'pending') {
        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn btn-success';
        approveBtn.textContent = '✓ Approve / Apply';
        approveBtn.onclick = () => {
          approveBtn.disabled = true;
          vscode.postMessage({ type: 'applyCrudAction', id: action.id });
        };

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn btn-secondary';
        rejectBtn.textContent = '✕ Reject';
        rejectBtn.onclick = () => {
          rejectBtn.disabled = true;
          vscode.postMessage({ type: 'rejectCrudAction', id: action.id });
        };

        actionsDiv.appendChild(approveBtn);
        actionsDiv.appendChild(rejectBtn);
      } else {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'status-text ' + action.status;
        statusSpan.textContent = action.status === 'applied' ? '✓ Applied' : (action.status === 'rejected' ? '✕ Rejected' : '⚠️ Failed: ' + (action.error || ''));
        actionsDiv.appendChild(statusSpan);
      }

      card.appendChild(actionsDiv);
      return card;
    }

    function updateCrudCard(action) {
      const card = document.getElementById(action.id);
      if (card) {
        const actionsDiv = card.querySelector('.crud-actions');
        if (actionsDiv) {
          actionsDiv.innerHTML = '';
          const statusSpan = document.createElement('span');
          statusSpan.className = 'status-text ' + action.status;
          statusSpan.textContent = action.status === 'applied' ? '✓ Applied successfully' : (action.status === 'rejected' ? '✕ Rejected by user' : '⚠️ ' + (action.error || 'Failed'));
          actionsDiv.appendChild(statusSpan);
        }
      }
    }

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
