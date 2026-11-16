import * as vscode from 'vscode';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { PythonEngine } from './pythonEngine';
import { applyUnifiedDiff } from './diffUtils';
import {
  buildWorkspaceContext,
  getActiveEditorContext,
  resolveWorkspaceFile,
  searchWorkspaceFiles,
  WorkspaceContextData,
} from './workspaceContext';
import { LocalDevInlineCompletionProvider } from './inlineCompletion';

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

export interface InferenceStats {
  eval_count?: number;
  prompt_eval_count?: number;
  total_tokens?: number;
  eval_duration_ms?: number;
  prompt_eval_duration_ms?: number;
  total_duration_ms?: number;
  tokens_per_second?: number;
  ttft_ms?: number;
  ram_available_bytes?: number;
  vram_free_bytes?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  crudActions?: CrudAction[];
  stats?: InferenceStats;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: 'learn' | 'edit';
  messages: ChatMessage[];
}

export interface OnboardingState {
  state: 'checking' | 'ollama_offline' | 'no_models' | 'ready';
  error?: Record<string, unknown>;
  hardware?: Record<string, unknown>;
  recommendation?: {
    model: string;
    reason: string;
    fit: string;
    tier?: string;
    num_ctx?: number;
    max_context_chars?: number;
    tiers?: Record<string, unknown>;
  };
  models?: Array<Record<string, unknown>>;
  selectedModel?: string;
  tiers?: Record<string, unknown>;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localdev-ai.chatView';

  private _view?: vscode.WebviewView;
  private _sessions: Record<string, ChatSession> = {};
  private _currentSessionId = '';
  private _mode: 'learn' | 'edit' = 'learn';
  private _isStreaming = false;
  private _cancellationSource?: vscode.CancellationTokenSource;
  private _activeFiles: string[] = [];
  private _includeWorkspace = false;
  private _onboardingState: OnboardingState = { state: 'checking' };
  private _installedModels: string[] = [];
  private _selectedModel = '';
  private _lastStats?: InferenceStats;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _engineGetter: () => PythonEngine | undefined,
    private readonly _inlineCompletionProvider?: LocalDevInlineCompletionProvider,
  ) {
    this._loadSessions();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
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

    // Run initial diagnostics check
    void this.refreshDiagnostics();
  }

  private _loadSessions(): void {
    const saved = this._context.workspaceState.get<Record<string, ChatSession>>('localdev-ai.sessions', {});
    this._sessions = saved;
    const lastActive = this._context.workspaceState.get<string>('localdev-ai.activeSessionId', '');

    if (lastActive && this._sessions[lastActive]) {
      this._currentSessionId = lastActive;
      this._mode = this._sessions[lastActive].mode || 'learn';
    } else {
      const keys = Object.keys(this._sessions);
      if (keys.length > 0) {
        this._currentSessionId = keys[keys.length - 1];
        this._mode = this._sessions[this._currentSessionId].mode || 'learn';
      } else {
        this._createNewSession('New Chat');
      }
    }
  }

  private async _saveSessions(): Promise<void> {
    await this._context.workspaceState.update('localdev-ai.sessions', this._sessions);
    await this._context.workspaceState.update('localdev-ai.activeSessionId', this._currentSessionId);
  }

  private _createNewSession(title = 'New Chat'): ChatSession {
    const session: ChatSession = {
      id: `session-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: this._mode,
      messages: [],
    };
    this._sessions[session.id] = session;
    this._currentSessionId = session.id;
    void this._saveSessions();
    return session;
  }

  private get _currentSession(): ChatSession {
    if (!this._sessions[this._currentSessionId]) {
      return this._createNewSession('New Chat');
    }
    return this._sessions[this._currentSessionId];
  }

  public async refreshDiagnostics(): Promise<void> {
    const engine = this._engineGetter();
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
      const recommendation = message.recommendation as OnboardingState['recommendation'];
      const tiers = message.tiers as Record<string, unknown> | undefined;
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
          tiers,
        });
      } else if (this._installedModels.length === 0) {
        this._updateOnboarding({
          state: 'no_models',
          hardware,
          recommendation,
          models,
          tiers,
        });
      } else {
        this._updateOnboarding({
          state: 'ready',
          hardware,
          recommendation,
          models,
          selectedModel: this._selectedModel,
          tiers,
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
      activeSession: this._currentSession,
      sessions: Object.values(this._sessions).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      })),
      autocompleteEnabled: this._inlineCompletionProvider?.isEnabled() ?? true,
    });
  }

  private async _handleWebviewMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready': {
        await this.refreshDiagnostics();
        this._syncEditorContext();
        this._sendSessionsUpdate();
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
          this._currentSession.mode = this._mode;
          void this._saveSessions();
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

      case 'stopOllama': {
        await this._stopOllamaService();
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

      case 'copyModel': {
        const source = typeof message.source === 'string' ? message.source : '';
        const destination = typeof message.destination === 'string' ? message.destination : '';
        if (source && destination) {
          await this._copyModel(source, destination);
        }
        break;
      }

      case 'deleteModel': {
        const model = typeof message.model === 'string' ? message.model : '';
        if (model) {
          await this._deleteModel(model);
        }
        break;
      }

      case 'toggleAutocomplete': {
        if (this._inlineCompletionProvider) {
          const enabled = !this._inlineCompletionProvider.isEnabled();
          this._inlineCompletionProvider.setEnabled(enabled);
          this._postMessage({ type: 'autocompleteToggled', enabled });
          void vscode.window.showInformationMessage(`LocalDev AI: Tab Autocomplete ${enabled ? 'Enabled' : 'Disabled'}`);
        }
        break;
      }

      case 'newSession': {
        const session = this._createNewSession('New Chat');
        this._postMessage({ type: 'sessionSwitched', session });
        this._sendSessionsUpdate();
        break;
      }

      case 'switchSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (sessionId && this._sessions[sessionId]) {
          this._currentSessionId = sessionId;
          this._mode = this._sessions[sessionId].mode || 'learn';
          void this._saveSessions();
          this._postMessage({ type: 'sessionSwitched', session: this._sessions[sessionId] });
          this._sendSessionsUpdate();
        }
        break;
      }

      case 'renameSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        const title = typeof message.title === 'string' ? message.title.trim() : '';
        if (sessionId && title && this._sessions[sessionId]) {
          this._sessions[sessionId].title = title;
          void this._saveSessions();
          this._sendSessionsUpdate();
        }
        break;
      }

      case 'deleteSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (sessionId && this._sessions[sessionId]) {
          delete this._sessions[sessionId];
          const remaining = Object.keys(this._sessions);
          if (remaining.length === 0) {
            this._createNewSession('New Chat');
          } else if (this._currentSessionId === sessionId) {
            this._currentSessionId = remaining[remaining.length - 1];
          }
          void this._saveSessions();
          this._postMessage({ type: 'sessionSwitched', session: this._currentSession });
          this._sendSessionsUpdate();
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
        this._currentSession.messages = [];
        void this._saveSessions();
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

  private _sendSessionsUpdate(): void {
    this._postMessage({
      type: 'sessionsList',
      activeSessionId: this._currentSessionId,
      sessions: Object.values(this._sessions).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      })),
    });
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
      const engine = this._engineGetter();
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

  private async _stopOllamaService(): Promise<void> {
    try {
      // Unload model weights from RAM/VRAM via keep_alive: 0
      const config = vscode.workspace.getConfiguration('localdev-ai');
      const endpoint = config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
      if (this._selectedModel) {
        try {
          await fetch(`${endpoint}/api/generate`, {
            method: 'POST',
            body: JSON.stringify({ model: this._selectedModel, keep_alive: 0 }),
            headers: { 'Content-Type': 'application/json' },
          });
        } catch {}
      }

      // Stop Ollama process
      const cmd = process.platform === 'win32'
        ? 'taskkill /IM ollama.exe /F 2>nul & taskkill /IM ollama_llama_server.exe /F 2>nul'
        : 'pkill -f ollama 2>/dev/null || killall ollama 2>/dev/null';

      exec(cmd, () => {
        void vscode.window.showInformationMessage('Ollama stopped and RAM released.');
        setTimeout(() => {
          void this.refreshDiagnostics();
        }, 1000);
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Failed to stop Ollama: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const engine = this._engineGetter();
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
          ollama_timeout_seconds: 600,
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

  private async _copyModel(source: string, destination: string): Promise<void> {
    const engine = this._engineGetter();
    if (!engine) return;

    try {
      const config = vscode.workspace.getConfiguration('localdev-ai');
      await engine.request('copy_model', {
        ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
        source,
        destination,
      });
      void vscode.window.showInformationMessage(`Duplicated model "${source}" as "${destination}".`);
      await this.refreshDiagnostics();
    } catch (error) {
      void vscode.window.showErrorMessage(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async _deleteModel(model: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete model "${model}" from local Ollama storage?`,
      { modal: true },
      'Delete',
      'Cancel',
    );
    if (confirm !== 'Delete') return;

    const engine = this._engineGetter();
    if (!engine) return;

    try {
      const config = vscode.workspace.getConfiguration('localdev-ai');
      await engine.request('delete_model', {
        ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
        model,
      });
      void vscode.window.showInformationMessage(`Deleted model "${model}".`);
      await this.refreshDiagnostics();
    } catch (error) {
      void vscode.window.showErrorMessage(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const session = this._currentSession;

    // Auto-title session from first user message
    if (session.messages.length === 0) {
      session.title = userPrompt.slice(0, 26).trim() + (userPrompt.length > 26 ? '...' : '');
      this._sendSessionsUpdate();
    }

    // Add user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userPrompt,
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);
    session.updatedAt = Date.now();
    void this._saveSessions();

    this._postMessage({
      type: 'messageAdded',
      message: userMsg,
    });

    await this._runAssistantTurn();
  }

  private async _runAssistantTurn(observationPrompt?: string): Promise<void> {
    const engine = this._engineGetter();
    if (!engine) {
      void vscode.window.showErrorMessage('The LocalDev AI engine is not running.');
      return;
    }

    if (!this._selectedModel) {
      void vscode.window.showWarningMessage('No Ollama model selected. Please select or pull a model first.');
      return;
    }

    const session = this._currentSession;

    if (observationPrompt) {
      const obsMsg: ChatMessage = {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: observationPrompt,
        timestamp: Date.now(),
      };
      session.messages.push(obsMsg);
      this._postMessage({ type: 'messageAdded', message: obsMsg });
    }

    const assistantMsgId = `assistant-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      crudActions: [],
    };
    session.messages.push(assistantMsg);

    this._isStreaming = true;
    this._cancellationSource = new vscode.CancellationTokenSource();

    this._postMessage({
      type: 'streamStarted',
      id: assistantMsgId,
      role: 'assistant',
    });

    try {
      // Dynamic context budgeting based on detected tier
      const maxBudget = this._onboardingState.recommendation?.max_context_chars || 4500;
      const workspaceContext = await buildWorkspaceContext(
        session.messages.map((m) => m.content).slice(-3).join('\n'),
        {
          includeWorkspaceTree: this._includeWorkspace,
          explicitFilePaths: this._activeFiles,
          includeActiveEditor: true,
          maxBudgetChars: maxBudget,
        },
      );

      const config = vscode.workspace.getConfiguration('localdev-ai');
      const messagesPayload = session.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
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
      const stats = response.stats as InferenceStats | undefined;
      assistantMsg.stats = stats;
      this._lastStats = stats;

      // Parse structured CRUD actions or unified diffs
      const parsedActions = this._parseCrudActions(finalText);
      assistantMsg.crudActions = parsedActions;

      session.updatedAt = Date.now();
      void this._saveSessions();

      this._postMessage({
        type: 'streamFinished',
        id: assistantMsgId,
        content: finalText,
        crudActions: parsedActions,
        stats,
      });

      // Requirement 1: Automatic read tool observation handling
      const readActions = parsedActions.filter((a) => a.action === 'read');
      if (readActions.length > 0) {
        for (const readAction of readActions) {
          await this._autoExecuteRead(readAction);
        }
      }
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

  private async _autoExecuteRead(action: CrudAction): Promise<void> {
    const uri = await resolveWorkspaceFile(action.path);
    if (!uri) {
      action.status = 'failed';
      action.error = `File not found: ${action.path}`;
      this._postMessage({ type: 'crudActionUpdated', action });
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      action.status = 'applied';
      this._postMessage({ type: 'crudActionUpdated', action });

      const lineCount = text.split(/\r?\n/).length;
      const observationText = `[File Observation: ${action.path} (${lineCount} lines)]\n\`\`\`${path.extname(action.path).slice(1)}\n${text.slice(0, 3500)}\n\`\`\``;

      // Automatically trigger assistant follow-up turn to summarize or answer
      await this._runAssistantTurn(observationText);
    } catch (err) {
      action.status = 'failed';
      action.error = err instanceof Error ? err.message : String(err);
      this._postMessage({ type: 'crudActionUpdated', action });
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
      } catch {}
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
    const session = this._currentSession;
    let foundAction: CrudAction | undefined;
    for (const msg of session.messages) {
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
      void this._saveSessions();
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
      void vscode.window.showInformationMessage(`Rejected change to ${foundAction.path}`);
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showErrorMessage('Cannot execute workspace action: No folder is open.');
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const cleanRelative = path.normalize(foundAction.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const targetUri = vscode.Uri.joinPath(rootUri, cleanRelative);

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
        await this._autoExecuteRead(foundAction);
        return;
      }

      void this._saveSessions();
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
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
      --accent: #58a6ff;
      --success: #388a34;
      --danger: #d73a49;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top Bar */
    #top-bar {
      display: flex;
      flex-direction: column;
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      font-size: 11px;
    }

    .top-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 10px;
      background: rgba(255,255,255,0.06);
      font-weight: 500;
      cursor: pointer;
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
    }

    .model-actions-wrap {
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
      padding: 3px 5px;
      font-size: 11px;
      outline: none;
      max-width: 130px;
    }

    .session-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 6px 10px;
      background: rgba(0,0,0,0.15);
      border-top: 1px solid rgba(255,255,255,0.03);
    }

    select.session-select {
      flex: 1;
      background: var(--input-bg);
      color: var(--fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 2px 5px;
      font-size: 11px;
    }

    button.icon-btn {
      background: transparent;
      color: var(--fg);
      border: 1px solid transparent;
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button.icon-btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.12); }
    button.icon-btn.active { background: rgba(88, 166, 255, 0.2); border-color: var(--accent); color: var(--accent); }

    /* Telemetry Bar */
    #telemetry-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 10px;
      background: rgba(0,0,0,0.25);
      font-size: 10px;
      color: #8b949e;
      border-bottom: 1px solid var(--card-border);
    }

    /* Model Manager Drawer */
    #model-manager-drawer {
      display: none;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      font-size: 11px;
      max-height: 280px;
      overflow-y: auto;
    }
    .drawer-title { font-weight: 600; font-size: 12px; display: flex; align-items: center; justify-content: space-between; }
    .drawer-section { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 6px; }
    .drawer-input-row { display: flex; gap: 4px; }
    .drawer-input-row input { flex: 1; background: var(--input-bg); border: 1px solid var(--input-border); color: var(--fg); padding: 3px 6px; border-radius: 3px; font-size: 11px; }

    .tier-cards { display: grid; grid-template-columns: 1fr; gap: 4px; }
    .tier-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px;
      padding: 5px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tier-info { display: flex; flex-direction: column; }
    .tier-label { font-weight: 600; font-size: 10px; }
    .tier-desc { font-size: 9px; color: #8b949e; }

    /* Onboarding Card */
    #onboarding-container {
      margin: 10px;
      padding: 10px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .onboarding-title { font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 6px; }
    .onboarding-desc { font-size: 11px; line-height: 1.4; opacity: 0.9; }
    .onboarding-actions { display: flex; flex-wrap: wrap; gap: 6px; }

    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn.btn-secondary { background: transparent; border: 1px solid var(--card-border); color: var(--fg); }
    .btn.btn-secondary:hover { background: rgba(255,255,255,0.08); }
    .btn.btn-success { background: #238636; color: #fff; }
    .btn.btn-success:hover { background: #2ea043; }
    .btn.btn-danger { background: #da3633; color: #fff; }
    .btn.btn-danger:hover { background: #f85149; }

    .progress-bar { width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; display: none; }
    .progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width 0.3s ease; }

    /* Main Chat Stream */
    #chat-stream {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .chat-message { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
    .chat-bubble { padding: 8px 12px; border-radius: 6px; line-height: 1.45; word-break: break-word; font-size: 12px; }
    .user-message .chat-bubble { background: rgba(88, 166, 255, 0.12); border: 1px solid rgba(88, 166, 255, 0.25); align-self: flex-end; }
    .assistant-message .chat-bubble { background: var(--card-bg); border: 1px solid var(--card-border); align-self: flex-start; width: 100%; }
    .system-message .chat-bubble { background: rgba(255,255,255,0.04); border: 1px dashed rgba(255,255,255,0.15); font-size: 11px; color: #8b949e; }

    .msg-header { font-size: 10px; color: rgba(255,255,255,0.5); font-weight: 600; text-transform: uppercase; }
    .msg-stats { font-size: 9px; color: #8b949e; margin-top: 4px; display: inline-flex; align-items: center; gap: 6px; }

    /* Code Blocks */
    .code-container {
      margin: 8px 0;
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      overflow: hidden;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
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
    pre code { display: block; padding: 8px; overflow-x: auto; font-size: 11px; line-height: 1.4; }

    /* CRUD Card */
    .crud-card {
      margin: 8px 0;
      border: 1px solid var(--card-border);
      border-left: 3px solid var(--accent);
      background: rgba(0,0,0,0.25);
      border-radius: 4px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .crud-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .crud-badge { font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 3px; text-transform: uppercase; background: var(--accent); color: #fff; }
    .crud-badge.create { background: #2ea043; }
    .crud-badge.update { background: #0969da; }
    .crud-badge.delete { background: #cf222e; }
    .crud-badge.read { background: #8957e5; }
    .crud-path { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 11px; color: #e6edf3; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crud-diff-preview { background: var(--code-bg); border: 1px solid rgba(255,255,255,0.06); border-radius: 3px; padding: 6px; max-height: 160px; overflow: auto; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 11px; line-height: 1.35; white-space: pre-wrap; }
    .diff-line-add { color: #56d364; background: rgba(46, 160, 67, 0.15); display: block; }
    .diff-line-del { color: #f85149; background: rgba(248, 81, 73, 0.15); display: block; }
    .diff-line-info { color: #79c0ff; display: block; }
    .crud-actions { display: flex; align-items: center; gap: 6px; margin-top: 2px; }

    /* Bottom Input Bar */
    #bottom-bar {
      padding: 8px 10px;
      background: var(--card-bg);
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .context-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 10px; }
    .chip {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 2px 7px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .chip:hover { background: rgba(255,255,255,0.12); }
    .chip.active { background: rgba(88, 166, 255, 0.2); border-color: var(--accent); color: var(--accent); }
    .chip .chip-remove { font-weight: bold; cursor: pointer; }

    .toggle-pill {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 10px;
      background: rgba(255,255,255,0.06);
      cursor: pointer;
      user-select: none;
    }
    .toggle-pill.on { color: #56d364; }

    .mode-toggle {
      display: flex;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      font-size: 10px;
    }
    .mode-btn { background: transparent; border: none; color: var(--fg); padding: 2px 6px; cursor: pointer; font-size: 10px; }
    .mode-btn.active { background: var(--btn-bg); color: #fff; font-weight: 600; }

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
    #send-btn, #stop-btn { padding: 4px 8px; font-size: 11px; }
    #stop-btn { display: none; background: #da3633; }
  </style>
</head>
<body>
  <!-- Top Bar -->
  <div id="top-bar">
    <div class="top-row">
      <div class="status-pill" id="status-pill" title="Ollama Status">
        <div id="status-dot" class="status-dot"></div>
        <span id="status-text">Checking</span>
      </div>
      <div id="fit-badge" class="fit-badge" style="display:none;">Fit</div>
      <div class="model-actions-wrap">
        <select id="model-select" class="model-select" title="Active Model">
          <option value="">No model</option>
        </select>
        <button id="models-drawer-btn" class="icon-btn" title="Model Manager (Pull, Copy, Delete, Tiers)">⚙</button>
        <button id="stop-ollama-btn" class="icon-btn" title="Stop Ollama (Free RAM)">⏹</button>
        <button id="start-ollama-btn" class="icon-btn" title="Start Ollama">▶</button>
      </div>
    </div>

    <!-- Session Management Row -->
    <div class="session-row">
      <select id="session-select" class="session-select" title="Chat Session History"></select>
      <button id="new-chat-btn" class="icon-btn" title="New Chat Session">+ New</button>
      <button id="rename-chat-btn" class="icon-btn" title="Rename Current Chat">✏</button>
      <button id="delete-chat-btn" class="icon-btn" title="Delete Current Chat">🗑</button>
    </div>
  </div>

  <!-- Telemetry Bar -->
  <div id="telemetry-bar">
    <span id="telemetry-speed">⚡ Idle</span>
    <span id="telemetry-ttft">⏱ TTFT: --</span>
    <span id="telemetry-ram">🧠 RAM: --</span>
  </div>

  <!-- Model Manager Drawer -->
  <div id="model-manager-drawer">
    <div class="drawer-title">
      <span>Model Manager & Hardware Tiers</span>
      <button id="close-drawer-btn" class="icon-btn">✕</button>
    </div>

    <!-- Pull Custom Tag -->
    <div class="drawer-section">
      <span style="font-weight:600">Pull Custom Model Tag</span>
      <div class="drawer-input-row">
        <input type="text" id="custom-model-input" placeholder="e.g. qwen2.5-coder:0.5b">
        <button id="pull-custom-btn" class="btn">Pull Tag</button>
      </div>
      <span style="font-size:9px; color:#8b949e">
        <a href="https://ollama.com/library" target="_blank" style="color:var(--accent); text-decoration:none;">Search Ollama Library ↗</a>
      </span>
    </div>

    <!-- Duplicate / Copy Model -->
    <div class="drawer-section">
      <span style="font-weight:600">Duplicate / Copy Model</span>
      <div class="drawer-input-row">
        <input type="text" id="copy-dest-input" placeholder="New model name">
        <button id="copy-model-btn" class="btn btn-secondary">Duplicate</button>
      </div>
    </div>

    <!-- Hardware Tiers -->
    <div class="drawer-section">
      <span style="font-weight:600">Hardware Recommended Tiers</span>
      <div id="tier-cards-container" class="tier-cards"></div>
    </div>
  </div>

  <!-- Onboarding & Setup Card -->
  <div id="onboarding-container">
    <div class="onboarding-title">
      <span id="onboarding-icon">🚀</span>
      <span id="onboarding-header">Welcome to LocalDev AI</span>
    </div>
    <div id="onboarding-desc" class="onboarding-desc">Setting up local engine...</div>
    <div id="onboarding-actions" class="onboarding-actions"></div>
    <div id="pull-progress-bar" class="progress-bar">
      <div id="pull-progress-fill" class="progress-fill"></div>
    </div>
  </div>

  <!-- Chat Stream -->
  <div id="chat-stream"></div>

  <!-- Bottom Input Bar -->
  <div id="bottom-bar">
    <div class="context-bar">
      <span id="active-file-chip" class="chip" style="display:none;">
        <span id="active-file-label">📄 file</span>
      </span>
      <button id="attach-file-btn" class="chip" title="Attach file to context">+ @file</button>
      <button id="toggle-workspace-btn" class="chip" title="Include directory outline">+ @workspace</button>
      
      <div id="autocomplete-toggle" class="toggle-pill on" title="Toggle Tab Autocomplete Suggestions">
        ⚡ Tab Complete: <span id="autocomplete-state">ON</span>
      </div>

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
    const modelsDrawerBtn = document.getElementById('models-drawer-btn');
    const modelManagerDrawer = document.getElementById('model-manager-drawer');
    const closeDrawerBtn = document.getElementById('close-drawer-btn');
    const stopOllamaBtn = document.getElementById('stop-ollama-btn');
    const startOllamaBtn = document.getElementById('start-ollama-btn');
    const sessionSelect = document.getElementById('session-select');
    const newChatBtn = document.getElementById('new-chat-btn');
    const renameChatBtn = document.getElementById('rename-chat-btn');
    const deleteChatBtn = document.getElementById('delete-chat-btn');
    const telemetrySpeed = document.getElementById('telemetry-speed');
    const telemetryTtft = document.getElementById('telemetry-ttft');
    const telemetryRam = document.getElementById('telemetry-ram');
    const customModelInput = document.getElementById('custom-model-input');
    const pullCustomBtn = document.getElementById('pull-custom-btn');
    const copyDestInput = document.getElementById('copy-dest-input');
    const copyModelBtn = document.getElementById('copy-model-btn');
    const tierCardsContainer = document.getElementById('tier-cards-container');
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
    const autocompleteToggle = document.getElementById('autocomplete-toggle');
    const autocompleteState = document.getElementById('autocomplete-state');
    const modeLearnBtn = document.getElementById('mode-learn-btn');
    const modeEditBtn = document.getElementById('mode-edit-btn');

    let currentMode = 'learn';
    let currentStreamingMsgEl = null;

    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'onboardingState':
          renderOnboarding(msg.state, msg.installedModels, msg.selectedModel);
          if (msg.activeSession) renderSession(msg.activeSession);
          if (msg.sessions) renderSessionsList(msg.sessions, msg.activeSession?.id);
          if (typeof msg.autocompleteEnabled === 'boolean') updateAutocompletePill(msg.autocompleteEnabled);
          break;
        case 'sessionsList':
          renderSessionsList(msg.sessions, msg.activeSessionId);
          break;
        case 'sessionSwitched':
          renderSession(msg.session);
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
          finishStream(msg.id, msg.content, msg.crudActions, msg.stats);
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
        case 'autocompleteToggled':
          updateAutocompletePill(msg.enabled);
          break;
        case 'chatCleared':
          chatStream.innerHTML = '';
          break;
      }
    });

    // Model Drawer Toggle
    modelsDrawerBtn.addEventListener('click', () => {
      const isVisible = modelManagerDrawer.style.display === 'flex';
      modelManagerDrawer.style.display = isVisible ? 'none' : 'flex';
      modelsDrawerBtn.classList.toggle('active', !isVisible);
    });

    closeDrawerBtn.addEventListener('click', () => {
      modelManagerDrawer.style.display = 'none';
      modelsDrawerBtn.classList.remove('active');
    });

    // Ollama Process Controls
    stopOllamaBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopOllama' });
    });

    startOllamaBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'startOllama' });
    });

    // Model Selector
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value) {
        vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
      }
    });

    // Custom Model Pull
    pullCustomBtn.addEventListener('click', () => {
      const tag = customModelInput.value.trim();
      if (tag) {
        progressBar.style.display = 'block';
        vscode.postMessage({ type: 'pullModel', model: tag });
      }
    });

    // Copy Model
    copyModelBtn.addEventListener('click', () => {
      const dest = copyDestInput.value.trim();
      if (dest && modelSelect.value) {
        vscode.postMessage({ type: 'copyModel', source: modelSelect.value, destination: dest });
      }
    });

    // Session Switcher
    sessionSelect.addEventListener('change', () => {
      if (sessionSelect.value) {
        vscode.postMessage({ type: 'switchSession', sessionId: sessionSelect.value });
      }
    });

    newChatBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    renameChatBtn.addEventListener('click', () => {
      const currentTitle = sessionSelect.options[sessionSelect.selectedIndex]?.text || '';
      const newTitle = prompt('Rename this session:', currentTitle);
      if (newTitle && newTitle.trim()) {
        vscode.postMessage({ type: 'renameSession', sessionId: sessionSelect.value, title: newTitle.trim() });
      }
    });

    deleteChatBtn.addEventListener('click', () => {
      if (confirm('Delete this chat session?')) {
        vscode.postMessage({ type: 'deleteSession', sessionId: sessionSelect.value });
      }
    });

    // Autocomplete Toggle
    autocompleteToggle.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggleAutocomplete' });
    });

    function updateAutocompletePill(enabled) {
      autocompleteToggle.classList.toggle('on', enabled);
      autocompleteState.textContent = enabled ? 'ON' : 'OFF';
    }

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

    // Prompt input
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
    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelStream' }));
    attachFileBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickFileContext' }));
    toggleWorkspaceBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleWorkspaceContext' }));

    function submitPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    // Render Sessions
    function renderSessionsList(sessions, activeId) {
      sessionSelect.innerHTML = '';
      if (!sessions || sessions.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'New Chat';
        sessionSelect.appendChild(opt);
        return;
      }
      sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title || 'Untitled Session';
        if (s.id === activeId) opt.selected = true;
        sessionSelect.appendChild(opt);
      });
    }

    function renderSession(session) {
      chatStream.innerHTML = '';
      if (session.mode === 'edit') {
        modeEditBtn.classList.add('active');
        modeLearnBtn.classList.remove('active');
        currentMode = 'edit';
      } else {
        modeLearnBtn.classList.add('active');
        modeEditBtn.classList.remove('active');
        currentMode = 'learn';
      }

      if (!session.messages || session.messages.length === 0) {
        const welcome = document.createElement('div');
        welcome.className = 'chat-message assistant-message';
        welcome.innerHTML = '<div class="msg-header">LocalDev AI</div><div class="chat-bubble">👋 Ready for private, local development. Ask questions or type @filename to inspect code.</div>';
        chatStream.appendChild(welcome);
        return;
      }

      session.messages.forEach(msg => {
        appendMessage(msg);
      });
    }

    // Onboarding UI Rendering
    function renderOnboarding(state, models, selectedModel) {
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

      // Render Hardware Tier Recommendations in Drawer
      renderTierRecommendations(state);

      onboardingActions.innerHTML = '';

      if (state.state === 'ollama_offline') {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        fitBadge.style.display = 'none';
        stopOllamaBtn.style.display = 'none';
        startOllamaBtn.style.display = 'inline-flex';

        onboardingContainer.style.display = 'flex';
        onboardingHeader.textContent = 'Ollama Not Running';
        onboardingDesc.textContent = state.error?.message || 'Ollama is offline. Start it to run AI completely locally.';

        const startBtn = document.createElement('button');
        startBtn.className = 'btn btn-success';
        startBtn.textContent = '▶ Start Ollama';
        startBtn.onclick = () => vscode.postMessage({ type: 'startOllama' });

        const installBtn = document.createElement('button');
        installBtn.className = 'btn btn-secondary';
        installBtn.textContent = '📥 Install';
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
        statusText.textContent = 'Online';
        stopOllamaBtn.style.display = 'inline-flex';
        startOllamaBtn.style.display = 'none';
        onboardingContainer.style.display = 'flex';

        const rec = state.recommendation || { model: 'qwen2.5-coder:1.5b', reason: 'Balanced model for local hardware', fit: 'Comfortable' };
        fitBadge.style.display = 'inline-block';
        fitBadge.textContent = 'Fit: ' + rec.fit;

        onboardingHeader.textContent = 'Download First Model';
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
        statusText.textContent = 'Online';
        stopOllamaBtn.style.display = 'inline-flex';
        startOllamaBtn.style.display = 'none';
        onboardingContainer.style.display = 'none';

        if (state.recommendation) {
          fitBadge.style.display = 'inline-block';
          fitBadge.textContent = 'Fit: ' + state.recommendation.fit;
        }
      }
    }

    function renderTierRecommendations(state) {
      tierCardsContainer.innerHTML = '';
      const tiers = state.tiers?.tiers || state.recommendation?.tiers;
      if (!tiers) return;

      Object.entries(tiers).forEach(([key, info]) => {
        const card = document.createElement('div');
        card.className = 'tier-card';
        card.innerHTML = '<div class="tier-info"><span class="tier-label">' + info.label + '</span><span class="tier-desc">' + info.description + '</span></div>';
        
        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '3px';

        (info.models || []).forEach(m => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-secondary';
          btn.style.fontSize = '9px';
          btn.style.padding = '2px 5px';
          btn.textContent = '+' + m.split(':')[1];
          btn.title = 'Pull ' + m;
          btn.onclick = () => {
            progressBar.style.display = 'block';
            vscode.postMessage({ type: 'pullModel', model: m });
          };
          btnGroup.appendChild(btn);
        });

        card.appendChild(btnGroup);
        tierCardsContainer.appendChild(card);
      });
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

    function appendMessage(msg) {
      const msgEl = document.createElement('div');
      msgEl.id = msg.id;
      msgEl.className = 'chat-message ' + (msg.role === 'user' ? 'user-message' : (msg.role === 'system' ? 'system-message' : 'assistant-message'));
      
      const header = document.createElement('div');
      header.className = 'msg-header';
      header.textContent = msg.role === 'user' ? 'You' : (msg.role === 'system' ? 'Observation' : 'LocalDev AI');
      
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.innerHTML = renderMarkdown(msg.content);

      if (msg.stats) {
        const statsEl = document.createElement('div');
        statsEl.className = 'msg-stats';
        statsEl.innerHTML = '⚡ ' + (msg.stats.tokens_per_second || 0) + ' tok/s · TTFT ' + (msg.stats.ttft_ms || 0) + 'ms · ' + (msg.stats.eval_count || 0) + ' tokens';
        bubble.appendChild(statsEl);
      }

      msgEl.appendChild(header);
      msgEl.appendChild(bubble);
      chatStream.appendChild(msgEl);
      chatStream.scrollTop = chatStream.scrollHeight;
    }

    function startStream(id, role) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'inline-block';
      telemetrySpeed.textContent = '⚡ Generating...';

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

    function finishStream(id, content, crudActions, stats) {
      sendBtn.style.display = 'inline-block';
      stopBtn.style.display = 'none';
      streamBuffer = '';

      if (stats) {
        telemetrySpeed.textContent = '⚡ ' + (stats.tokens_per_second || 0) + ' tok/s';
        telemetryTtft.textContent = '⏱ TTFT: ' + (stats.ttft_ms || 0) + 'ms';
        if (stats.ram_available_bytes) {
          const gib = (stats.ram_available_bytes / (1024 ** 3)).toFixed(1);
          telemetryRam.textContent = '🧠 RAM: ' + gib + ' GiB free';
        }
      }

      if (currentStreamingMsgEl) {
        const bubble = currentStreamingMsgEl.querySelector('.chat-bubble');
        if (bubble) {
          bubble.innerHTML = renderMarkdown(content);
          attachCodeButtons(bubble);

          if (stats) {
            const statsEl = document.createElement('div');
            statsEl.className = 'msg-stats';
            statsEl.innerHTML = '⚡ ' + (stats.tokens_per_second || 0) + ' tok/s · TTFT ' + (stats.ttft_ms || 0) + 'ms · ' + (stats.eval_count || 0) + ' tokens';
            bubble.appendChild(statsEl);
          }

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
      telemetrySpeed.textContent = '⚡ Stopped';
      streamBuffer = '';
      if (currentStreamingMsgEl) {
        const bubble = currentStreamingMsgEl.querySelector('.chat-bubble');
        if (bubble) {
          bubble.innerHTML += '<br><em>(Request cancelled)</em>';
        }
      }
      currentStreamingMsgEl = null;
    }

    function renderMarkdown(text) {
      if (!text) return '';
      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

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

      const inlineCodeRegex = new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g');
      html = html.replace(inlineCodeRegex, '<code>$1</code>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');
      html = html.replace(/^### (.*)$/gm, '<h4 style="margin:6px 0 2px">$1</h4>');
      html = html.replace(/^## (.*)$/gm, '<h3 style="margin:8px 0 3px">$1</h3>');
      html = html.replace(/^# (.*)$/gm, '<h2 style="margin:10px 0 4px">$1</h2>');
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

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'crud-actions';

      if (action.status === 'pending' && action.action !== 'read') {
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
        statusSpan.style.fontSize = '10px';
        statusSpan.style.color = action.status === 'applied' ? '#56d364' : (action.status === 'rejected' ? '#8b949e' : '#f85149');
        statusSpan.textContent = action.status === 'applied'
          ? (action.action === 'read' ? '📖 File read into context' : '✓ Applied')
          : (action.status === 'rejected' ? '✕ Rejected' : '⚠️ Failed: ' + (action.error || ''));
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
          statusSpan.style.fontSize = '10px';
          statusSpan.style.color = action.status === 'applied' ? '#56d364' : (action.status === 'rejected' ? '#8b949e' : '#f85149');
          statusSpan.textContent = action.status === 'applied'
            ? (action.action === 'read' ? '📖 File read into context' : '✓ Applied successfully')
            : (action.status === 'rejected' ? '✕ Rejected by user' : '⚠️ ' + (action.error || 'Failed'));
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
