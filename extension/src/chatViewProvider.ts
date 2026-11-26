import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'node:child_process';
import * as process from 'node:process';
import { setTimeout } from 'node:timers';
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
  execution_mode?: string;
  num_gpu?: number;
  num_ctx?: number;
  use_gpu?: boolean;
  gpu_present?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  crudActions?: CrudAction[];
  stats?: InferenceStats;
  isError?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: 'learn' | 'edit';
  messages: ChatMessage[];
}

export interface ModelCatalogItem {
  name: string;
  label: string;
  category: string;
  size_label: string;
  tier: string;
  description: string;
}

export interface OnboardingState {
  state: 'checking' | 'ollama_offline' | 'no_models' | 'ready';
  error?: Record<string, unknown>;
  hardware?: Record<string, unknown>;
  recommendation?: {
    model: string;
    alternatives?: string[];
    reason: string;
    fit: string;
    tier?: string;
    num_ctx?: number;
    max_context_chars?: number;
    tiers?: Record<string, unknown>;
    catalog?: ModelCatalogItem[];
  };
  models?: Array<Record<string, unknown>>;
  selectedModel?: string;
  tiers?: Record<string, unknown>;
}

const MAX_SAVED_SESSIONS = 30;
const MAX_JSONL_SAFE_BYTES = 52 * 1024;
const MAX_AUTO_READ_DEPTH = 2;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'localdev-ai.chatView';

  private _view?: vscode.WebviewView;
  private _sessions: Record<string, ChatSession> = {};
  private _currentSessionId = '';
  private _mode: 'learn' | 'edit' = 'learn';
  private _isStreaming = false;
  private _isPulling = false;
  private _cancellationSource?: vscode.CancellationTokenSource;
  private _pullCancellationSource?: vscode.CancellationTokenSource;
  private _activeFiles: string[] = [];
  private _includeWorkspace = false;
  private _onboardingState: OnboardingState = { state: 'checking' };
  private _installedModels: string[] = [];
  private _installedModelDetails: Array<Record<string, unknown>> = [];
  private _selectedModel = '';
  private _lastActiveEditor?: vscode.TextEditor;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _engineGetter: () => PythonEngine | undefined,
    private readonly _inlineCompletionProvider?: LocalDevInlineCompletionProvider,
  ) {
    this._loadSessions();
    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor && this._isEditableDocument(initialEditor.document)) {
      this._lastActiveEditor = initialEditor;
    }
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this._isEditableDocument(editor.document)) {
          this._lastActiveEditor = editor;
        }
        this._syncEditorContext();
      }),
    );
  }

  public dispose(): void {
    this._cancellationSource?.cancel();
    this._cancellationSource?.dispose();
    this._pullCancellationSource?.cancel();
    this._pullCancellationSource?.dispose();
    while (this._disposables.length > 0) {
      this._disposables.pop()?.dispose();
    }
  }

  private _isEditableDocument(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled';
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
        this._syncEditorContext();
      }
    });

    void this.refreshDiagnostics();
  }

  public startNewChat(): void {
    this._cancelStreaming();
    const session = this._createNewSession('New Chat');
    this._postMessage({ type: 'sessionSwitched', session });
    this._sendSessionsUpdate();
  }

  public async toggleGpu(explicitValue?: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('localdev-ai');
    const current = config.get<boolean>('useGpu', true);
    const next = typeof explicitValue === 'boolean' ? explicitValue : !current;
    await config.update('useGpu', next, vscode.ConfigurationTarget.Global);
    this.syncConfigState();
    void vscode.window.showInformationMessage(
      `LocalDev AI: dGPU offload ${next ? 'ON (GPU auto layers)' : 'OFF (CPU-only, num_gpu: 0)'}`,
    );
  }

  public syncConfigState(): void {
    const config = vscode.workspace.getConfiguration('localdev-ai');
    const selected = config.get<string>('selectedModel', '');
    if (selected && this._installedModels.includes(selected)) {
      this._selectedModel = selected;
    }
    this._postMessage({
      type: 'configUpdated',
      useGpu: config.get<boolean>('useGpu', true),
      numGpuLayers: config.get<number>('numGpuLayers', -1),
      numCtx: config.get<number>('numCtx', 0),
      selectedModel: this._selectedModel,
      autocompleteEnabled: this._inlineCompletionProvider?.isEnabled() ?? true,
      maxRenderedMessages: config.get<number>('maxRenderedMessages', 100),
    });
  }

  private _loadSessions(): void {
    const saved = this._context.workspaceState.get<Record<string, ChatSession>>('localdev-ai.sessions', {});
    this._sessions = saved && typeof saved === 'object' ? { ...saved } : {};
    const lastActive = this._context.workspaceState.get<string>('localdev-ai.activeSessionId', '');

    if (lastActive && this._sessions[lastActive]) {
      this._currentSessionId = lastActive;
      this._mode = this._sessions[lastActive].mode || 'learn';
    } else {
      const sorted = this._sortedSessions();
      if (sorted.length > 0) {
        this._currentSessionId = sorted[0].id;
        this._mode = sorted[0].mode || 'learn';
      } else {
        this._createNewSession('New Chat');
      }
    }
  }

  private _sortedSessions(): ChatSession[] {
    return Object.values(this._sessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  private async _saveSessions(): Promise<void> {
    const sorted = this._sortedSessions();
    if (sorted.length > MAX_SAVED_SESSIONS) {
      for (const stale of sorted.slice(MAX_SAVED_SESSIONS)) {
        if (stale.id !== this._currentSessionId) {
          delete this._sessions[stale.id];
        }
      }
    }
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

      this._installedModelDetails = models;
      this._installedModels = models
        .map((m) => (typeof m.name === 'string' ? m.name : ''))
        .filter(Boolean);

      if (selected && this._installedModels.includes(selected)) {
        this._selectedModel = selected;
      } else {
        this._selectedModel = this._installedModels.length > 0 ? this._installedModels[0] : '';
      }

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
    const config = vscode.workspace.getConfiguration('localdev-ai');
    this._postMessage({
      type: 'onboardingState',
      state,
      installedModels: this._installedModels,
      installedModelDetails: this._installedModelDetails,
      selectedModel: this._selectedModel,
      activeSession: this._currentSession,
      sessions: this._sortedSessions().map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      })),
      useGpu: config.get<boolean>('useGpu', true),
      numGpuLayers: config.get<number>('numGpuLayers', -1),
      numCtx: config.get<number>('numCtx', 0),
      autocompleteEnabled: this._inlineCompletionProvider?.isEnabled() ?? true,
      maxRenderedMessages: config.get<number>('maxRenderedMessages', 100),
    });
  }

  private async _handleWebviewMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready': {
        await this.refreshDiagnostics();
        this._syncEditorContext();
        this._postMessage({ type: 'sessionSwitched', session: this._currentSession });
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

      case 'toggleGpu': {
        await this.toggleGpu();
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
        const modelName = typeof message.model === 'string' ? message.model.trim() : (this._onboardingState.recommendation?.model || '');
        if (modelName) {
          await this._pullModel(modelName);
        }
        break;
      }

      case 'cancelPull': {
        this._cancelPull();
        break;
      }

      case 'copyModel': {
        const source = typeof message.source === 'string' ? message.source.trim() : this._selectedModel;
        let destination = typeof message.destination === 'string' ? message.destination.trim() : '';
        if (source && !destination) {
          const input = await vscode.window.showInputBox({
            prompt: `Duplicate "${source}" as:`,
            value: `${source}-copy`,
            ignoreFocusOut: true,
          });
          destination = input ? input.trim() : '';
        }
        if (source && destination) {
          await this._copyModel(source, destination);
        }
        break;
      }

      case 'deleteModel': {
        const model = typeof message.model === 'string' ? message.model.trim() : '';
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
        this.startNewChat();
        break;
      }

      case 'switchSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (sessionId && this._sessions[sessionId]) {
          this._cancelStreaming();
          this._currentSessionId = sessionId;
          this._mode = this._sessions[sessionId].mode || 'learn';
          void this._saveSessions();
          this._postMessage({ type: 'sessionSwitched', session: this._sessions[sessionId] });
          this._sendSessionsUpdate();
        }
        break;
      }

      case 'renameSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : this._currentSessionId;
        const targetSession = this._sessions[sessionId];
        if (!targetSession) break;
        let title = typeof message.title === 'string' ? message.title.trim() : '';
        if (!title) {
          const entered = await vscode.window.showInputBox({
            prompt: 'Rename chat session',
            value: targetSession.title,
            ignoreFocusOut: true,
          });
          title = entered ? entered.trim() : '';
        }
        if (title) {
          targetSession.title = title;
          targetSession.updatedAt = Date.now();
          void this._saveSessions();
          this._postMessage({ type: 'sessionRenamed', sessionId, title });
          this._sendSessionsUpdate();
        }
        break;
      }

      case 'deleteSession': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : this._currentSessionId;
        const targetSession = this._sessions[sessionId];
        if (!targetSession) break;
        if (!message.confirmed) {
          const confirm = await vscode.window.showWarningMessage(
            `Delete chat session "${targetSession.title}"?`,
            { modal: true },
            'Delete',
          );
          if (confirm !== 'Delete') break;
        }
        if (sessionId === this._currentSessionId) {
          this._cancelStreaming();
        }
        delete this._sessions[sessionId];
        const sorted = this._sortedSessions();
        if (sorted.length === 0) {
          this._createNewSession('New Chat');
        } else if (this._currentSessionId === sessionId) {
          this._currentSessionId = sorted[0].id;
          this._mode = sorted[0].mode || 'learn';
        }
        void this._saveSessions();
        this._postMessage({ type: 'sessionSwitched', session: this._currentSession });
        this._sendSessionsUpdate();
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
        const insertMode = message.mode === 'replace' ? 'replace' : 'insert';
        if (code) {
          await this._insertCodeAtCursor(code, insertMode);
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
        this._cancelStreaming();
        this._currentSession.messages = [];
        this._currentSession.updatedAt = Date.now();
        void this._saveSessions();
        this._postMessage({ type: 'sessionSwitched', session: this._currentSession });
        this._sendSessionsUpdate();
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
      sessions: this._sortedSessions().map((s) => ({
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
            isSelection: editorCtx.isSelection,
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
    if (this._isPulling) {
      void vscode.window.showWarningMessage('A model download is already in progress. Cancel it first to start another.');
      return;
    }
    if (this._isStreaming) {
      void vscode.window.showWarningMessage('Wait for the active chat response to finish before pulling a model.');
      return;
    }
    const engine = this._engineGetter();
    if (!engine) {
      void vscode.window.showErrorMessage('LocalDev AI engine is not running.');
      return;
    }

    const config = vscode.workspace.getConfiguration('localdev-ai');
    this._isPulling = true;
    this._pullCancellationSource = new vscode.CancellationTokenSource();
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
        this._pullCancellationSource.token,
      );

      this._postMessage({ type: 'pullCompleted', model: modelName });
      void vscode.window.showInformationMessage(`LocalDev AI: Model "${modelName}" downloaded successfully!`);
      await this.refreshDiagnostics();
      if (this._installedModels.includes(modelName)) {
        await this._selectModel(modelName);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this._postMessage({ type: 'pullFailed', model: modelName, error: msg });
      if (!msg.toLowerCase().includes('cancelled')) {
        void vscode.window.showErrorMessage(`Failed to pull "${modelName}": ${msg}`);
      } else {
        void vscode.window.showInformationMessage(`Cancelled download for "${modelName}".`);
      }
    } finally {
      this._isPulling = false;
      this._pullCancellationSource?.dispose();
      this._pullCancellationSource = undefined;
    }
  }

  private _cancelPull(): void {
    if (this._isPulling && this._pullCancellationSource) {
      this._pullCancellationSource.cancel();
    }
  }

  private async _copyModel(source: string, destination: string): Promise<void> {
    const engine = this._engineGetter();
    if (!engine) return;

    try {
      const config = vscode.workspace.getConfiguration('localdev-ai');
      await engine.request('copy_model', {
        ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
        ollama_timeout_seconds: config.get<number>('ollamaTimeoutSeconds', 5),
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
        ollama_timeout_seconds: config.get<number>('ollamaTimeoutSeconds', 5),
        model,
      });
      if (this._selectedModel === model) {
        await config.update('selectedModel', '', vscode.ConfigurationTarget.Global);
        this._selectedModel = '';
      }
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

  private async _resolveTargetEditor(createIfMissing = false): Promise<vscode.TextEditor | undefined> {
    const active = vscode.window.activeTextEditor;
    if (active && this._isEditableDocument(active.document)) {
      return active;
    }

    const visible = vscode.window.visibleTextEditors.find((ed) => this._isEditableDocument(ed.document));
    if (visible) {
      return vscode.window.showTextDocument(visible.document, {
        viewColumn: visible.viewColumn,
        preserveFocus: false,
      });
    }

    if (this._lastActiveEditor && !this._lastActiveEditor.document.isClosed) {
      return vscode.window.showTextDocument(this._lastActiveEditor.document, {
        viewColumn: this._lastActiveEditor.viewColumn ?? vscode.ViewColumn.One,
        preserveFocus: false,
      });
    }

    if (this._activeFiles.length > 0) {
      const uri = await resolveWorkspaceFile(this._activeFiles[0]);
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        return vscode.window.showTextDocument(doc, { preserveFocus: false });
      }
    }

    if (createIfMissing) {
      const doc = await vscode.workspace.openTextDocument({ content: '' });
      return vscode.window.showTextDocument(doc, { preserveFocus: false });
    }

    return undefined;
  }

  private async _insertCodeAtCursor(code: string, mode: 'insert' | 'replace' = 'insert'): Promise<void> {
    try {
      const editor = await this._resolveTargetEditor(true);
      if (!editor) {
        void vscode.window.showErrorMessage('No editable text editor could be opened for code insertion.');
        return;
      }

      const focusedEditor = await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn ?? vscode.ViewColumn.One,
        preserveFocus: false,
      });

      const selection = focusedEditor.selection;
      const startPos = !selection.isEmpty ? selection.start : selection.active;

      const applied = await focusedEditor.edit((editBuilder) => {
        if (mode === 'replace' && !selection.isEmpty) {
          editBuilder.replace(selection, code);
        } else if (!selection.isEmpty) {
          editBuilder.replace(selection, code);
        } else {
          editBuilder.insert(selection.active, code);
        }
      });

      if (!applied) {
        void vscode.window.showErrorMessage(
          `Could not insert code into "${path.basename(focusedEditor.document.fileName || 'Untitled')}". Check if the file is read-only.`,
        );
        return;
      }

      const lines = code.split(/\r?\n/);
      const endLine = startPos.line + lines.length - 1;
      const endChar = lines.length === 1
        ? startPos.character + lines[0].length
        : lines[lines.length - 1].length;
      const endPos = new vscode.Position(endLine, endChar);
      const insertedRange = new vscode.Range(startPos, endPos);

      focusedEditor.selection = new vscode.Selection(endPos, endPos);
      focusedEditor.revealRange(insertedRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this._lastActiveEditor = focusedEditor;

      const label = focusedEditor.document.isUntitled
        ? 'new untitled editor'
        : vscode.workspace.asRelativePath(focusedEditor.document.uri);
      void vscode.window.showInformationMessage(`LocalDev AI: Inserted code into ${label}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Code insertion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private _buildBudgetedMessages(
    session: ChatSession,
    maxHistoryTurns: number,
    numCtx: number,
  ): Array<{ role: string; content: string }> {
    const valid = session.messages.filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant' || m.role === 'system')
        && !m.isError
        && m.content.trim().length > 0,
    );

    const recent = valid.slice(-Math.max(2, maxHistoryTurns));
    const maxTotalMsgChars = Math.min(28000, Math.max(4000, Math.floor(numCtx * 2.2)));
    let used = 0;
    const selectedReversed: Array<{ role: string; content: string }> = [];

    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const m = recent[i];
      const isLatest = i === recent.length - 1;
      const perMsgCap = isLatest ? Math.min(10000, maxTotalMsgChars) : 2400;
      let content = m.content;
      if (content.length > perMsgCap) {
        content = content.slice(0, perMsgCap) + '\n... [earlier message truncated]';
      }
      if (!isLatest && used + content.length > maxTotalMsgChars) {
        break;
      }
      selectedReversed.push({ role: m.role, content });
      used += content.length;
    }

    return selectedReversed.reverse();
  }

  private _fitPayloadToJsonlLimit(
    baseOptions: Record<string, unknown>,
    messages: Array<{ role: string; content: string }>,
    workspaceContext: WorkspaceContextData,
  ): { messages: Array<{ role: string; content: string }>; workspace_context: WorkspaceContextData } {
    const msgCopy = messages.map((m) => ({ ...m }));
    const ctxCopy: WorkspaceContextData = {
      active_file: workspaceContext.active_file ? { ...workspaceContext.active_file } : undefined,
      referenced_files: workspaceContext.referenced_files.map((r) => ({ ...r })),
      directory_tree: workspaceContext.directory_tree,
    };

    const measure = (): number =>
      Buffer.byteLength(
        JSON.stringify({
          protocol_version: '1',
          type: 'request',
          request_id: 'request-0000000000000-0000',
          task: 'chat_session',
          options: {
            ...baseOptions,
            messages: msgCopy,
            workspace_context: ctxCopy,
          },
        }),
        'utf8',
      );

    while (measure() > MAX_JSONL_SAFE_BYTES && msgCopy.length > 1) {
      msgCopy.shift();
    }
    if (measure() > MAX_JSONL_SAFE_BYTES && ctxCopy.directory_tree) {
      ctxCopy.directory_tree = undefined;
    }
    while (measure() > MAX_JSONL_SAFE_BYTES && ctxCopy.referenced_files.length > 0) {
      ctxCopy.referenced_files.pop();
    }
    if (measure() > MAX_JSONL_SAFE_BYTES && ctxCopy.active_file && ctxCopy.active_file.content.length > 1200) {
      ctxCopy.active_file.content = ctxCopy.active_file.content.slice(0, 1200) + '\n... [trimmed]';
    }
    if (measure() > MAX_JSONL_SAFE_BYTES && msgCopy.length === 1 && msgCopy[0].content.length > 8000) {
      msgCopy[0].content = msgCopy[0].content.slice(0, 8000) + '\n... [trimmed to engine payload limit]';
    }

    return { messages: msgCopy, workspace_context: ctxCopy };
  }

  private async _sendUserMessage(userPrompt: string): Promise<void> {
    if (this._isStreaming) {
      void vscode.window.showInformationMessage('Wait for the current response or click Stop before sending another message.');
      return;
    }
    if (this._isPulling) {
      void vscode.window.showInformationMessage('A model download is currently running. Please wait or cancel it first.');
      return;
    }

    const session = this._currentSession;

    if (session.messages.length === 0) {
      session.title = userPrompt.slice(0, 32).trim() + (userPrompt.length > 32 ? '...' : '');
      this._sendSessionsUpdate();
    }

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
      sessionId: session.id,
      message: userMsg,
    });

    await this._runAssistantTurn();
  }

  private async _runAssistantTurn(observationPrompt?: string, autoReadDepth = 0): Promise<void> {
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
    const targetSessionId = session.id;

    if (observationPrompt) {
      const obsMsg: ChatMessage = {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: observationPrompt,
        timestamp: Date.now(),
      };
      session.messages.push(obsMsg);
      this._postMessage({ type: 'messageAdded', sessionId: targetSessionId, message: obsMsg });
    }

    const assistantMsgId = `assistant-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`;
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
      sessionId: targetSessionId,
      id: assistantMsgId,
      role: 'assistant',
    });

    try {
      const config = vscode.workspace.getConfiguration('localdev-ai');
      const useGpu = config.get<boolean>('useGpu', true);
      const numGpuLayers = config.get<number>('numGpuLayers', -1);
      const configuredNumCtx = config.get<number>('numCtx', 0);
      const recommendedNumCtx = this._onboardingState.recommendation?.num_ctx || 4096;
      const numCtx = configuredNumCtx > 0 ? configuredNumCtx : recommendedNumCtx;
      const maxHistoryTurns = config.get<number>('maxHistoryTurns', 8);
      const inferenceTimeout = config.get<number>('inferenceTimeoutSeconds', 120);

      // Scan @file references only from recent USER messages (never assistant code blocks with @decorators)
      const recentUserText = session.messages
        .filter((m) => m.role === 'user')
        .slice(-2)
        .map((m) => m.content)
        .join('\n');

      const maxContextBudget = Math.min(
        this._onboardingState.recommendation?.max_context_chars || 4500,
        Math.max(2500, Math.floor(numCtx * 1.1)),
      );

      const workspaceContext = await buildWorkspaceContext(recentUserText, {
        includeWorkspaceTree: this._includeWorkspace,
        explicitFilePaths: this._activeFiles,
        includeActiveEditor: true,
        maxBudgetChars: maxContextBudget,
      });

      const budgetedMessages = this._buildBudgetedMessages(session, maxHistoryTurns, numCtx);

      const baseOptions: Record<string, unknown> = {
        ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
        ollama_timeout_seconds: Math.max(10, inferenceTimeout),
        model: this._selectedModel,
        mode: this._mode,
        use_gpu: useGpu,
        num_gpu: useGpu ? numGpuLayers : 0,
        num_ctx: numCtx,
      };

      const fitted = this._fitPayloadToJsonlLimit(baseOptions, budgetedMessages, workspaceContext);

      let accumulatedContent = '';

      const response = await engine.request(
        'chat_session',
        {
          ...baseOptions,
          messages: fitted.messages,
          workspace_context: fitted.workspace_context,
        },
        (event) => {
          accumulatedContent += event.text;
          assistantMsg.content = accumulatedContent;
          this._postMessage({
            type: 'streamToken',
            sessionId: targetSessionId,
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

      const parsedActions = this._parseCrudActions(finalText);
      assistantMsg.crudActions = parsedActions;

      session.updatedAt = Date.now();
      void this._saveSessions();

      this._postMessage({
        type: 'streamFinished',
        sessionId: targetSessionId,
        id: assistantMsgId,
        content: finalText,
        crudActions: parsedActions,
        stats,
      });

      this._isStreaming = false;
      this._cancellationSource?.dispose();
      this._cancellationSource = undefined;

      // Batch automatic read observations within bounded depth
      const readActions = parsedActions.filter((a) => a.action === 'read');
      if (readActions.length > 0 && autoReadDepth < MAX_AUTO_READ_DEPTH && this._currentSessionId === targetSessionId) {
        const observations = await this._collectReadObservations(readActions);
        if (observations.length > 0 && this._currentSessionId === targetSessionId) {
          await this._runAssistantTurn(observations.join('\n\n'), autoReadDepth + 1);
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.toLowerCase().includes('cancelled')) {
        if (!assistantMsg.content.trim()) {
          session.messages = session.messages.filter((m) => m.id !== assistantMsgId);
        } else {
          assistantMsg.isError = true;
        }
        void this._saveSessions();
        this._postMessage({
          type: 'streamCancelled',
          sessionId: targetSessionId,
          id: assistantMsgId,
        });
      } else {
        assistantMsg.isError = true;
        assistantMsg.content = `⚠️ **Error:** ${errMsg}`;
        void this._saveSessions();
        this._postMessage({
          type: 'streamFinished',
          sessionId: targetSessionId,
          id: assistantMsgId,
          content: assistantMsg.content,
          isError: true,
        });
        void vscode.window.showErrorMessage(`LocalDev AI Chat: ${errMsg}`);
      }
    } finally {
      this._isStreaming = false;
      this._cancellationSource?.dispose();
      this._cancellationSource = undefined;
    }
  }

  private async _collectReadObservations(readActions: CrudAction[]): Promise<string[]> {
    const observations: string[] = [];
    for (const action of readActions.slice(0, 3)) {
      const uri = await resolveWorkspaceFile(action.path);
      if (!uri) {
        action.status = 'failed';
        action.error = `File not found: ${action.path}`;
        this._postMessage({ type: 'crudActionUpdated', action });
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf-8');
        action.status = 'applied';
        this._postMessage({ type: 'crudActionUpdated', action });

        const lineCount = text.split(/\r?\n/).length;
        const ext = path.extname(action.path).slice(1);
        observations.push(
          `[File Observation: ${action.path} (${lineCount} lines)]\n\`\`\`${ext}\n${text.slice(0, 2600)}\n\`\`\``,
        );
      } catch (err) {
        action.status = 'failed';
        action.error = err instanceof Error ? err.message : String(err);
        this._postMessage({ type: 'crudActionUpdated', action });
      }
    }
    return observations;
  }

  private _cancelStreaming(): void {
    if (this._isStreaming && this._cancellationSource) {
      this._cancellationSource.cancel();
    }
  }

  private _parseCrudActions(text: string): CrudAction[] {
    const actions: CrudAction[] = [];

    const toolRegex = /```(?:localdev_tool|json)\s*\r?\n([\s\S]*?)\r?\n```/g;
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
              content: parsed.content !== undefined ? String(parsed.content) : undefined,
              diff: parsed.diff !== undefined ? String(parsed.diff) : undefined,
              status: 'pending',
            });
          }
        }
      } catch {}
    }

    if (actions.length === 0) {
      const diffRegex = /```diff\s*\r?\n([\s\S]*?)\r?\n```/g;
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
      foundAction.status = 'failed';
      foundAction.error = 'No workspace folder is open.';
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
      void vscode.window.showErrorMessage('Cannot execute workspace action: No folder is open.');
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const cleanRelative = path.normalize(foundAction.path).replace(/^(\.\.(\/|\\|$))+/, '');
    let targetUri = vscode.Uri.joinPath(rootUri, cleanRelative);

    const relCheck = path.relative(rootUri.fsPath, targetUri.fsPath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      foundAction.status = 'failed';
      foundAction.error = 'Security violation: Path is outside workspace.';
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
      void vscode.window.showErrorMessage(foundAction.error);
      return;
    }

    try {
      if (foundAction.action === 'create') {
        const content = foundAction.content || '';
        const parentDir = path.dirname(targetUri.fsPath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf-8'));
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
        editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this._lastActiveEditor = editor;
        foundAction.status = 'applied';
        foundAction.error = undefined;
        void vscode.window.showInformationMessage(`Created file: ${foundAction.path}`);
      } else if (foundAction.action === 'update') {
        // Fallback resolution if path didn't exist directly at workspace root
        try {
          await vscode.workspace.fs.stat(targetUri);
        } catch {
          const resolved = await resolveWorkspaceFile(foundAction.path);
          if (resolved) {
            targetUri = resolved;
          }
        }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        const originalText = doc.getText();
        let nextText: string;

        if (foundAction.diff) {
          const patched = applyUnifiedDiff(foundAction.diff, originalText);
          if (patched === undefined) {
            throw new Error('Diff hunks did not match the current file content.');
          }
          nextText = patched;
        } else if (foundAction.content !== undefined) {
          nextText = foundAction.content;
        } else {
          throw new Error('No content or diff provided for update.');
        }

        const edit = new vscode.WorkspaceEdit();
        const lastLineIdx = Math.max(0, doc.lineCount - 1);
        const lastLineLen = doc.lineCount > 0 ? doc.lineAt(lastLineIdx).text.length : 0;
        const fullRange = new vscode.Range(0, 0, lastLineIdx, lastLineLen);
        edit.replace(doc.uri, fullRange, nextText);

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          throw new Error('VS Code rejected the workspace edit.');
        }
        await doc.save();

        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
        const firstChangedLine = this._findFirstChangedLine(originalText, nextText);
        const targetPos = new vscode.Position(firstChangedLine, 0);
        editor.selection = new vscode.Selection(targetPos, targetPos);
        editor.revealRange(new vscode.Range(targetPos, targetPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this._lastActiveEditor = editor;

        foundAction.status = 'applied';
        foundAction.error = undefined;
        void vscode.window.showInformationMessage(`Applied update to: ${vscode.workspace.asRelativePath(doc.uri)}`);
      } else if (foundAction.action === 'delete') {
        await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
        foundAction.status = 'applied';
        foundAction.error = undefined;
        void vscode.window.showInformationMessage(`Deleted file: ${foundAction.path}`);
      } else if (foundAction.action === 'read') {
        const obs = await this._collectReadObservations([foundAction]);
        if (obs.length > 0) {
          await this._runAssistantTurn(obs.join('\n\n'), 1);
        }
        return;
      }

      void this._saveSessions();
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
    } catch (err) {
      foundAction.status = 'failed';
      foundAction.error = err instanceof Error ? err.message : String(err);
      void this._saveSessions();
      this._postMessage({ type: 'crudActionUpdated', action: foundAction });
      void vscode.window.showErrorMessage(`Action failed: ${foundAction.error}`);
    }
  }

  private _findFirstChangedLine(before: string, after: string): number {
    const a = before.split(/\r?\n/);
    const b = after.split(/\r?\n/);
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      if (a[i] !== b[i]) return i;
    }
    return Math.max(0, len - 1);
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
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border, var(--vscode-widget-border));
      --surface: var(--vscode-editorWidget-background, var(--vscode-sideBarSectionHeader-background));
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, var(--border));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn2-bg: var(--vscode-button-secondaryBackground);
      --btn2-fg: var(--vscode-button-secondaryForeground);
      --btn2-hover: var(--vscode-button-secondaryHoverBackground);
      --code-bg: var(--vscode-textCodeBlock-background);
      --focus: var(--vscode-focusBorder);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --ok: var(--vscode-testing-iconPassed, #3fb950);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --err: var(--vscode-errorForeground, #f14c4c);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Compact Copilot-style Header */
    #header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 0 0 auto;
    }

    .header-row {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    .session-title {
      font-size: 12px;
      font-weight: 600;
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--muted);
    }
    .status-dot.online { background: var(--ok); }
    .status-dot.offline { background: var(--err); }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      flex: 0 0 auto;
    }

    .icon-btn {
      background: transparent;
      color: var(--fg);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      white-space: nowrap;
      font-family: inherit;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.14)); }
    .icon-btn.active {
      background: var(--vscode-toolbar-activeBackground, rgba(128,128,128,0.22));
      border-color: var(--focus);
      color: var(--accent);
    }

    .pill-toggle {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
    }
    .pill-toggle.on {
      color: var(--ok);
      border-color: var(--ok);
      background: rgba(63, 185, 80, 0.12);
    }
    .pill-toggle.off {
      color: var(--warn);
      border-color: var(--warn);
      background: rgba(204, 167, 0, 0.1);
    }

    .header-subrow {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    select.compact-select {
      flex: 1;
      min-width: 0;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 3px 5px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }
    select.compact-select:focus { border-color: var(--focus); }

    .fit-pill {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 5px;
      border-radius: 4px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      white-space: nowrap;
    }

    /* Collapsible Drawers */
    .drawer {
      display: none;
      flex-direction: column;
      gap: 8px;
      padding: 8px 10px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      max-height: 55vh;
      overflow-y: auto;
      flex: 0 0 auto;
    }
    .drawer.open { display: flex; }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--muted);
    }

    .drawer-section {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .drawer-section:first-of-type { border-top: none; padding-top: 0; }

    .drawer-label { font-size: 11px; font-weight: 600; }
    .drawer-row { display: flex; gap: 4px; align-items: center; }
    .drawer-input {
      flex: 1;
      min-width: 0;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }
    .drawer-input:focus { border-color: var(--focus); }

    .list-items { display: flex; flex-direction: column; gap: 4px; }
    .list-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 5px 7px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--bg);
      font-size: 11px;
    }
    .list-item.active { border-color: var(--focus); }
    .list-item-main {
      flex: 1;
      min-width: 0;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .list-item-title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .list-item-meta { font-size: 10px; color: var(--muted); }
    .list-item-actions { display: flex; align-items: center; gap: 3px; flex: 0 0 auto; }

    .tier-group-title {
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      margin-top: 4px;
    }

    .cat-tag {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      border: 1px solid var(--border);
      color: var(--muted);
      text-transform: uppercase;
    }

    /* Buttons */
    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
      white-space: nowrap;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-sm { padding: 2px 6px; font-size: 10px; }
    .btn-secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
    .btn-secondary:hover { background: var(--btn2-hover); }
    .btn-danger { background: var(--err); color: #fff; }

    /* Progress & Onboarding */
    #pull-banner {
      display: none;
      flex-direction: column;
      gap: 4px;
      padding: 6px 10px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      flex: 0 0 auto;
    }
    .progress-bar {
      width: 100%;
      height: 4px;
      background: rgba(128, 128, 128, 0.25);
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.2s ease;
    }

    #onboarding-card {
      display: none;
      flex-direction: column;
      gap: 8px;
      margin: 10px;
      padding: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
      flex: 0 0 auto;
    }
    .onboarding-title { font-weight: 600; }
    .onboarding-desc { color: var(--muted); font-size: 11px; line-height: 1.4; }
    .onboarding-actions { display: flex; flex-wrap: wrap; gap: 6px; }

    /* Message Stream */
    #chat-stream {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .empty-state {
      margin: auto;
      max-width: 300px;
      text-align: center;
      padding: 16px 8px;
      color: var(--muted);
    }
    .empty-state h2 { color: var(--fg); font-size: 15px; margin-bottom: 6px; }
    .empty-state p { font-size: 12px; line-height: 1.45; margin-bottom: 12px; }
    .starter-prompts { display: flex; flex-direction: column; gap: 6px; }
    .starter-chip {
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--fg);
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 11px;
      text-align: left;
      font-family: inherit;
    }
    .starter-chip:hover { border-color: var(--focus); color: var(--accent); }

    .chat-message { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
    .msg-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
    }

    .chat-bubble {
      padding: 8px 10px;
      border-radius: 6px;
      line-height: 1.5;
      word-break: break-word;
      font-size: 12.5px;
    }
    .user-message .chat-bubble {
      background: var(--input-bg);
      border: 1px solid var(--border);
    }
    .assistant-message .chat-bubble {
      background: transparent;
      padding: 2px 0;
    }
    .system-message .chat-bubble {
      background: var(--surface);
      border: 1px dashed var(--border);
      font-size: 11px;
      color: var(--muted);
    }
    .chat-bubble code.inline-code {
      background: var(--code-bg);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }

    .msg-telemetry {
      font-size: 10px;
      color: var(--muted);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 2px;
    }

    /* Code Blocks */
    .code-container {
      margin: 8px 0;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 8px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 10px;
      color: var(--muted);
    }
    .code-actions { display: flex; gap: 4px; }
    .code-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 3px;
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
      font-family: inherit;
    }
    .code-btn:hover { background: var(--btn2-hover, rgba(128,128,128,0.2)); }
    pre.code-pre {
      margin: 0;
      padding: 8px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      line-height: 1.45;
    }

    /* CRUD / Patch Cards */
    .crud-card {
      margin: 8px 0;
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      background: var(--surface);
      border-radius: 6px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .crud-header { display: flex; align-items: center; gap: 6px; }
    .crud-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      color: #fff;
      background: var(--accent);
    }
    .crud-badge.create { background: #2ea043; }
    .crud-badge.update { background: #0969da; }
    .crud-badge.delete { background: #cf222e; }
    .crud-badge.read { background: #8957e5; }
    .crud-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .crud-diff-preview {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px;
      max-height: 160px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.35;
      white-space: pre;
    }
    .diff-line-add { color: #3fb950; display: block; }
    .diff-line-del { color: #f85149; display: block; }
    .diff-line-info { color: #58a6ff; display: block; }
    .crud-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .crud-card summary { cursor: pointer; color: var(--accent); font-size: 10px; user-select: none; }

    /* Status & Telemetry Strip */
    #status-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 10px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      font-size: 10px;
      color: var(--muted);
      flex: 0 0 auto;
    }

    /* Composer Footer */
    #composer-footer {
      padding: 8px;
      background: var(--bg);
      flex: 0 0 auto;
      position: relative;
    }
    .composer-box {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 8px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .composer-box:focus-within { border-color: var(--focus); }

    .context-chips {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      font-size: 10px;
    }
    .chip {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 10px;
      padding: 2px 7px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
    }
    .chip:hover { border-color: var(--focus); }
    .chip.active { border-color: var(--accent); color: var(--accent); }
    .chip-remove { font-weight: 700; opacity: 0.75; }
    .chip-remove:hover { opacity: 1; }

    textarea#prompt-input {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      color: var(--input-fg);
      font-family: inherit;
      font-size: 12.5px;
      resize: none;
      min-height: 22px;
      max-height: 120px;
      line-height: 1.4;
    }

    .composer-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .mode-switch {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 5px;
      overflow: hidden;
    }
    .mode-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
    }
    .mode-btn.active { background: var(--btn-bg); color: var(--btn-fg); font-weight: 600; }

    .send-controls { display: flex; align-items: center; gap: 4px; }
    #stop-btn { display: none; }

    /* @file mention autocomplete popup */
    #mention-popup {
      display: none;
      position: absolute;
      bottom: calc(100% - 4px);
      left: 8px;
      right: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      max-height: 150px;
      overflow-y: auto;
      z-index: 20;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    }
    .mention-item {
      padding: 5px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mention-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }

    .streaming-cursor {
      display: inline-block;
      animation: blink 1s steps(1) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
  </style>
</head>
<body>
  <!-- Compact Header -->
  <div id="header">
    <div class="header-row">
      <div class="session-title" id="header-session-title" title="Active Chat Session">
        <span id="status-dot" class="status-dot" title="Ollama status"></span>
        <span id="session-title-text">New Chat</span>
      </div>
      <div class="header-actions">
        <button id="new-chat-btn" class="icon-btn" title="New Chat">＋</button>
        <button id="history-btn" class="icon-btn" title="Chat History">History</button>
        <button id="models-btn" class="icon-btn" title="Manage & Pull Models">Models</button>
        <button id="gpu-toggle-btn" class="pill-toggle on" title="Toggle dedicated GPU offload (ON = auto GPU layers, OFF = CPU only, num_gpu: 0)">dGPU: ON</button>
        <button id="ollama-ctrl-btn" class="icon-btn" title="Start / Stop Ollama">▶</button>
      </div>
    </div>
    <div class="header-subrow">
      <select id="model-select" class="compact-select" title="Active Ollama Model">
        <option value="">No model selected</option>
      </select>
      <span id="fit-badge" class="fit-pill" style="display:none;">Fit</span>
      <button id="autocomplete-toggle" class="pill-toggle on" title="Toggle Tab Autocomplete">Tab: ON</button>
    </div>
  </div>

  <!-- History Drawer -->
  <div id="history-drawer" class="drawer">
    <div class="drawer-header">
      <span>Chat History</span>
      <div class="header-actions">
        <button id="clear-chat-btn" class="btn btn-sm btn-secondary" title="Clear current chat messages">Clear</button>
        <button id="close-history-btn" class="icon-btn">✕</button>
      </div>
    </div>
    <div id="history-list" class="list-items"></div>
  </div>

  <!-- Model Manager Drawer -->
  <div id="models-drawer" class="drawer">
    <div class="drawer-header">
      <span>Model Manager</span>
      <div class="header-actions">
        <button id="refresh-models-btn" class="btn btn-sm btn-secondary">Refresh</button>
        <button id="close-models-btn" class="icon-btn">✕</button>
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-label">Pull Any Ollama Tag</div>
      <div class="drawer-row">
        <input id="custom-model-input" class="drawer-input" type="text" placeholder="e.g. qwen3:4b, llama3.2:3b, gemma3:4b">
        <button id="pull-custom-btn" class="btn btn-sm">Pull</button>
        <button id="cancel-pull-btn" class="btn btn-sm btn-danger" style="display:none;">Cancel</button>
      </div>
      <div class="list-item-meta">Browse tags at <a href="https://ollama.com/library" target="_blank" style="color:var(--accent);">ollama.com/library</a></div>
    </div>

    <div class="drawer-section">
      <div class="drawer-label">Installed Models</div>
      <div id="installed-models-list" class="list-items"></div>
    </div>

    <div class="drawer-section">
      <div class="drawer-label">Recommended &amp; Curated Models</div>
      <div id="catalog-list" class="list-items"></div>
    </div>
  </div>

  <!-- Pull Progress Banner -->
  <div id="pull-banner">
    <div class="drawer-row" style="justify-content:space-between;">
      <span id="pull-status-text">Pulling model...</span>
      <button id="banner-cancel-pull-btn" class="btn btn-sm btn-danger">Cancel</button>
    </div>
    <div class="progress-bar"><div id="pull-progress-fill" class="progress-fill"></div></div>
  </div>

  <!-- Onboarding Banner -->
  <div id="onboarding-card">
    <div id="onboarding-title" class="onboarding-title">Checking local runtime...</div>
    <div id="onboarding-desc" class="onboarding-desc"></div>
    <div id="onboarding-actions" class="onboarding-actions"></div>
  </div>

  <!-- Chat Stream -->
  <div id="chat-stream"></div>

  <!-- Compact Telemetry Strip -->
  <div id="status-strip">
    <span id="telemetry-speed">Idle</span>
    <span id="telemetry-exec">dGPU: ON</span>
    <span id="telemetry-ram">RAM: --</span>
  </div>

  <!-- Composer Footer -->
  <div id="composer-footer">
    <div id="mention-popup"></div>
    <div class="composer-box">
      <div class="context-chips" id="context-chips">
        <span id="active-file-chip" class="chip" style="display:none;" title="Active editor file automatically included">
          <span id="active-file-label">file</span>
        </span>
        <button id="attach-file-btn" class="chip" title="Attach workspace files">+ @file</button>
        <button id="toggle-workspace-btn" class="chip" title="Include workspace file tree">+ @workspace</button>
      </div>
      <textarea id="prompt-input" rows="1" placeholder="Ask a question or type @ to reference a file..."></textarea>
      <div class="composer-controls">
        <div class="mode-switch">
          <button id="mode-learn-btn" class="mode-btn active" title="Ask &amp; Explain">Ask</button>
          <button id="mode-edit-btn" class="mode-btn" title="Propose File Edits &amp; Patches">Edit</button>
        </div>
        <div class="send-controls">
          <button id="send-btn" class="btn">Send</button>
          <button id="stop-btn" class="btn btn-danger">Stop</button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const statusDot = document.getElementById('status-dot');
    const sessionTitleText = document.getElementById('session-title-text');
    const newChatBtn = document.getElementById('new-chat-btn');
    const historyBtn = document.getElementById('history-btn');
    const modelsBtn = document.getElementById('models-btn');
    const gpuToggleBtn = document.getElementById('gpu-toggle-btn');
    const ollamaCtrlBtn = document.getElementById('ollama-ctrl-btn');
    const modelSelect = document.getElementById('model-select');
    const fitBadge = document.getElementById('fit-badge');
    const autocompleteToggle = document.getElementById('autocomplete-toggle');

    const historyDrawer = document.getElementById('history-drawer');
    const closeHistoryBtn = document.getElementById('close-history-btn');
    const clearChatBtn = document.getElementById('clear-chat-btn');
    const historyList = document.getElementById('history-list');

    const modelsDrawer = document.getElementById('models-drawer');
    const closeModelsBtn = document.getElementById('close-models-btn');
    const refreshModelsBtn = document.getElementById('refresh-models-btn');
    const customModelInput = document.getElementById('custom-model-input');
    const pullCustomBtn = document.getElementById('pull-custom-btn');
    const cancelPullBtn = document.getElementById('cancel-pull-btn');
    const installedModelsList = document.getElementById('installed-models-list');
    const catalogList = document.getElementById('catalog-list');

    const pullBanner = document.getElementById('pull-banner');
    const pullStatusText = document.getElementById('pull-status-text');
    const pullProgressFill = document.getElementById('pull-progress-fill');
    const bannerCancelPullBtn = document.getElementById('banner-cancel-pull-btn');

    const onboardingCard = document.getElementById('onboarding-card');
    const onboardingTitle = document.getElementById('onboarding-title');
    const onboardingDesc = document.getElementById('onboarding-desc');
    const onboardingActions = document.getElementById('onboarding-actions');

    const chatStream = document.getElementById('chat-stream');
    const telemetrySpeed = document.getElementById('telemetry-speed');
    const telemetryExec = document.getElementById('telemetry-exec');
    const telemetryRam = document.getElementById('telemetry-ram');

    const promptInput = document.getElementById('prompt-input');
    const mentionPopup = document.getElementById('mention-popup');
    const activeFileChip = document.getElementById('active-file-chip');
    const activeFileLabel = document.getElementById('active-file-label');
    const attachFileBtn = document.getElementById('attach-file-btn');
    const toggleWorkspaceBtn = document.getElementById('toggle-workspace-btn');
    const modeLearnBtn = document.getElementById('mode-learn-btn');
    const modeEditBtn = document.getElementById('mode-edit-btn');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');

    let currentMode = 'learn';
    let currentSessionId = '';
    let hasRenderedInitialSession = false;
    let isStreaming = false;
    let isPulling = false;
    let isOllamaOnline = false;
    let currentUseGpu = true;
    let maxRenderedMessages = 100;
    let lastOnboarding = null;
    let installedModelNames = [];
    let installedModelDetails = [];
    let selectedModelName = '';
    let streamBuffer = '';
    let streamingMsgId = '';
    const codeBlockStore = new Map();

    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'onboardingState': {
          lastOnboarding = msg.state;
          installedModelNames = msg.installedModels || [];
          installedModelDetails = msg.installedModelDetails || [];
          selectedModelName = msg.selectedModel || '';
          if (typeof msg.useGpu === 'boolean') updateGpuToggle(msg.useGpu, msg.state?.hardware);
          if (typeof msg.autocompleteEnabled === 'boolean') updateAutocompleteToggle(msg.autocompleteEnabled);
          if (typeof msg.maxRenderedMessages === 'number') {
            maxRenderedMessages = Math.max(20, Math.min(200, Math.floor(msg.maxRenderedMessages)));
          }
          renderOnboarding(msg.state);
          renderModelManager(msg.state);
          if (msg.sessions) renderHistoryList(msg.sessions, msg.activeSession?.id);
          if (msg.activeSession && (!hasRenderedInitialSession || msg.activeSession.id !== currentSessionId)) {
            hasRenderedInitialSession = true;
            renderSession(msg.activeSession);
          }
          break;
        }
        case 'configUpdated': {
          if (typeof msg.useGpu === 'boolean') updateGpuToggle(msg.useGpu, lastOnboarding?.hardware);
          if (typeof msg.autocompleteEnabled === 'boolean') updateAutocompleteToggle(msg.autocompleteEnabled);
          if (typeof msg.selectedModel === 'string' && msg.selectedModel) {
            selectedModelName = msg.selectedModel;
            modelSelect.value = selectedModelName;
            renderModelManager(lastOnboarding);
          }
          break;
        }
        case 'modelSelected': {
          selectedModelName = msg.model || '';
          modelSelect.value = selectedModelName;
          renderModelManager(lastOnboarding);
          break;
        }
        case 'sessionsList': {
          renderHistoryList(msg.sessions || [], msg.activeSessionId);
          break;
        }
        case 'sessionSwitched': {
          hasRenderedInitialSession = true;
          renderSession(msg.session);
          closeDrawers();
          break;
        }
        case 'sessionRenamed': {
          if (msg.sessionId === currentSessionId) {
            sessionTitleText.textContent = msg.title || 'Chat';
          }
          break;
        }
        case 'pullStarted': {
          isPulling = true;
          pullBanner.style.display = 'flex';
          pullStatusText.textContent = 'Starting pull for ' + msg.model + '...';
          pullProgressFill.style.width = '2%';
          cancelPullBtn.style.display = 'inline-flex';
          pullCustomBtn.disabled = true;
          break;
        }
        case 'pullProgress': {
          pullBanner.style.display = 'flex';
          pullStatusText.textContent = msg.model + ': ' + msg.text;
          const pctMatch = String(msg.text || '').match(/(\\d+)%/);
          if (pctMatch) {
            pullProgressFill.style.width = pctMatch[1] + '%';
          }
          break;
        }
        case 'pullCompleted': {
          resetPullUi();
          break;
        }
        case 'pullFailed': {
          resetPullUi();
          break;
        }
        case 'messageAdded': {
          if (msg.sessionId && msg.sessionId !== currentSessionId) break;
          removeEmptyState();
          appendMessage(msg.message);
          break;
        }
        case 'streamStarted': {
          if (msg.sessionId && msg.sessionId !== currentSessionId) break;
          removeEmptyState();
          startStream(msg.id);
          break;
        }
        case 'streamToken': {
          if (msg.sessionId && msg.sessionId !== currentSessionId) break;
          appendStreamToken(msg.id, msg.text);
          break;
        }
        case 'streamFinished': {
          if (msg.sessionId && msg.sessionId !== currentSessionId) break;
          finishStream(msg.id, msg.content, msg.crudActions, msg.stats);
          break;
        }
        case 'streamCancelled': {
          if (msg.sessionId && msg.sessionId !== currentSessionId) break;
          cancelStream(msg.id);
          break;
        }
        case 'crudActionUpdated': {
          updateCrudCard(msg.action);
          break;
        }
        case 'activeEditorChanged': {
          updateEditorContext(msg.editor);
          break;
        }
        case 'contextUpdated': {
          updateContextChips(msg.activeFiles || []);
          break;
        }
        case 'workspaceToggled': {
          toggleWorkspaceBtn.classList.toggle('active', !!msg.enabled);
          break;
        }
        case 'autocompleteToggled': {
          updateAutocompleteToggle(!!msg.enabled);
          break;
        }
        case 'fileSearchResults': {
          renderMentionPopup(msg.results || []);
          break;
        }
      }
    });

    function closeDrawers() {
      historyDrawer.classList.remove('open');
      modelsDrawer.classList.remove('open');
      historyBtn.classList.remove('active');
      modelsBtn.classList.remove('active');
    }

    historyBtn.addEventListener('click', () => {
      const opening = !historyDrawer.classList.contains('open');
      closeDrawers();
      if (opening) {
        historyDrawer.classList.add('open');
        historyBtn.classList.add('active');
      }
    });
    closeHistoryBtn.addEventListener('click', closeDrawers);

    modelsBtn.addEventListener('click', () => {
      const opening = !modelsDrawer.classList.contains('open');
      closeDrawers();
      if (opening) {
        modelsDrawer.classList.add('open');
        modelsBtn.classList.add('active');
      }
    });
    closeModelsBtn.addEventListener('click', closeDrawers);

    newChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    clearChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearChat' }));
    refreshModelsBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
    gpuToggleBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleGpu' }));
    autocompleteToggle.addEventListener('click', () => vscode.postMessage({ type: 'toggleAutocomplete' }));

    ollamaCtrlBtn.addEventListener('click', () => {
      vscode.postMessage({ type: isOllamaOnline ? 'stopOllama' : 'startOllama' });
    });

    modelSelect.addEventListener('change', () => {
      if (modelSelect.value) {
        vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
      }
    });

    pullCustomBtn.addEventListener('click', () => {
      const tag = customModelInput.value.trim();
      if (tag) {
        vscode.postMessage({ type: 'pullModel', model: tag });
      }
    });

    cancelPullBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelPull' }));
    bannerCancelPullBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelPull' }));

    modeLearnBtn.addEventListener('click', () => setMode('learn'));
    modeEditBtn.addEventListener('click', () => setMode('edit'));

    function setMode(mode) {
      currentMode = mode === 'edit' ? 'edit' : 'learn';
      modeLearnBtn.classList.toggle('active', currentMode === 'learn');
      modeEditBtn.classList.toggle('active', currentMode === 'edit');
      vscode.postMessage({ type: 'setMode', mode: currentMode });
    }

    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
      const val = promptInput.value;
      const cursor = promptInput.selectionStart || val.length;
      const slice = val.slice(0, cursor);
      const mentionMatch = slice.match(/@([a-zA-Z0-9_\\.\\-/\\\\]*)$/);
      if (mentionMatch) {
        vscode.postMessage({ type: 'searchFiles', query: mentionMatch[1] });
      } else {
        mentionPopup.style.display = 'none';
      }
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        mentionPopup.style.display = 'none';
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        mentionPopup.style.display = 'none';
        submitPrompt();
      }
    });

    sendBtn.addEventListener('click', submitPrompt);
    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelStream' }));
    attachFileBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickFileContext' }));
    toggleWorkspaceBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleWorkspaceContext' }));

    function submitPrompt() {
      if (isStreaming) return;
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      vscode.postMessage({ type: 'sendMessage', text });
    }

    function resetPullUi() {
      isPulling = false;
      pullBanner.style.display = 'none';
      pullProgressFill.style.width = '0%';
      cancelPullBtn.style.display = 'none';
      pullCustomBtn.disabled = false;
    }

    function updateGpuToggle(useGpu, hardware) {
      currentUseGpu = useGpu;
      const hasGpu = !!hardware?.gpu?.present;
      const gpuName = hardware?.gpu?.name || '';
      gpuToggleBtn.className = 'pill-toggle ' + (useGpu ? 'on' : 'off');
      gpuToggleBtn.textContent = useGpu ? 'dGPU: ON' : 'dGPU: OFF';
      gpuToggleBtn.title = useGpu
        ? ('dGPU offload ON' + (gpuName ? ' (' + gpuName + ')' : ' (auto GPU layers)'))
        : 'dGPU offload OFF (CPU-only, num_gpu: 0)';
      telemetryExec.textContent = useGpu ? (hasGpu ? 'GPU: Auto' : 'GPU: Auto (CPU fallback)') : 'CPU Only';
    }

    function updateAutocompleteToggle(enabled) {
      autocompleteToggle.className = 'pill-toggle ' + (enabled ? 'on' : 'off');
      autocompleteToggle.textContent = 'Tab: ' + (enabled ? 'ON' : 'OFF');
    }

    function renderOnboarding(state) {
      if (!state) return;
      modelSelect.innerHTML = '';
      if (installedModelNames.length > 0) {
        installedModelNames.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === selectedModelName) opt.selected = true;
          modelSelect.appendChild(opt);
        });
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models installed';
        modelSelect.appendChild(opt);
      }

      onboardingActions.innerHTML = '';

      if (state.state === 'ollama_offline') {
        isOllamaOnline = false;
        statusDot.className = 'status-dot offline';
        statusDot.title = 'Ollama Offline';
        ollamaCtrlBtn.textContent = '▶ Start';
        ollamaCtrlBtn.title = 'Start Ollama Server';
        fitBadge.style.display = 'none';

        onboardingCard.style.display = 'flex';
        onboardingTitle.textContent = 'Ollama is Offline';
        onboardingDesc.textContent = state.error?.message || 'Start local Ollama to chat and run models privately.';

        const startBtn = createBtn('▶ Start Ollama', 'btn', () => vscode.postMessage({ type: 'startOllama' }));
        const installBtn = createBtn('Install', 'btn btn-secondary', () => vscode.postMessage({ type: 'installOllama' }));
        const retryBtn = createBtn('Retry', 'btn btn-secondary', () => vscode.postMessage({ type: 'refreshModels' }));
        onboardingActions.append(startBtn, installBtn, retryBtn);
      } else if (state.state === 'no_models') {
        isOllamaOnline = true;
        statusDot.className = 'status-dot online';
        statusDot.title = 'Ollama Online (No models)';
        ollamaCtrlBtn.textContent = '⏹ Stop';
        ollamaCtrlBtn.title = 'Stop Ollama & Free RAM';

        const rec = state.recommendation || { model: 'qwen2.5-coder:1.5b', reason: 'Compact coding model.', fit: 'Comfortable', alternatives: [] };
        fitBadge.style.display = 'inline-block';
        fitBadge.textContent = rec.fit || 'Ready';

        onboardingCard.style.display = 'flex';
        onboardingTitle.textContent = 'Pull a Starter Model';
        onboardingDesc.textContent = rec.reason || 'Choose a recommended model or open Models to pick any tag.';

        const pullPrimary = createBtn('⬇ Pull ' + rec.model, 'btn', () => vscode.postMessage({ type: 'pullModel', model: rec.model }));
        onboardingActions.appendChild(pullPrimary);
        (rec.alternatives || []).slice(0, 2).forEach((alt) => {
          const altBtn = createBtn('⬇ ' + alt, 'btn btn-secondary', () => vscode.postMessage({ type: 'pullModel', model: alt }));
          onboardingActions.appendChild(altBtn);
        });
        const browseBtn = createBtn('Browse All', 'btn btn-secondary', () => {
          closeDrawers();
          modelsDrawer.classList.add('open');
          modelsBtn.classList.add('active');
        });
        onboardingActions.appendChild(browseBtn);
      } else {
        isOllamaOnline = true;
        statusDot.className = 'status-dot online';
        statusDot.title = 'Ollama Online';
        ollamaCtrlBtn.textContent = '⏹ Stop';
        ollamaCtrlBtn.title = 'Stop Ollama & Free RAM';
        onboardingCard.style.display = 'none';

        const selectedFit = installedModelDetails.find((m) => m.name === selectedModelName)?.fit || state.recommendation?.fit;
        if (selectedFit) {
          fitBadge.style.display = 'inline-block';
          fitBadge.textContent = String(selectedFit);
        } else {
          fitBadge.style.display = 'none';
        }
      }
    }

    function renderModelManager(state) {
      installedModelsList.innerHTML = '';
      if (installedModelDetails.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'list-item-meta';
        empty.textContent = 'No local models installed yet.';
        installedModelsList.appendChild(empty);
      } else {
        installedModelDetails.forEach((m) => {
          const name = String(m.name || '');
          const sizeGib = typeof m.size_bytes === 'number' ? (m.size_bytes / (1024 ** 3)).toFixed(1) + ' GiB' : '';
          const fit = m.fit ? String(m.fit) : '';
          const isActive = name === selectedModelName;

          const row = document.createElement('div');
          row.className = 'list-item' + (isActive ? ' active' : '');

          const main = document.createElement('div');
          main.className = 'list-item-main';
          main.onclick = () => vscode.postMessage({ type: 'selectModel', model: name });

          const title = document.createElement('div');
          title.className = 'list-item-title';
          title.textContent = name + (isActive ? ' (Active)' : '');

          const meta = document.createElement('div');
          meta.className = 'list-item-meta';
          meta.textContent = [sizeGib, fit].filter(Boolean).join(' · ') || 'Installed';

          main.append(title, meta);

          const actions = document.createElement('div');
          actions.className = 'list-item-actions';

          if (!isActive) {
            actions.appendChild(createBtn('Use', 'btn btn-sm', () => vscode.postMessage({ type: 'selectModel', model: name })));
          }
          actions.appendChild(createBtn('Copy', 'btn btn-sm btn-secondary', () => vscode.postMessage({ type: 'copyModel', source: name })));
          actions.appendChild(createBtn('Delete', 'btn btn-sm btn-danger', () => vscode.postMessage({ type: 'deleteModel', model: name })));

          row.append(main, actions);
          installedModelsList.appendChild(row);
        });
      }

      catalogList.innerHTML = '';
      const tiers = state?.tiers?.tiers || state?.recommendation?.tiers;
      const activeTier = state?.tiers?.tier || state?.recommendation?.tier || '';
      if (!tiers) return;

      Object.entries(tiers).forEach(([tierKey, tierInfo]) => {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'tier-group-title';
        groupTitle.textContent = (tierInfo.label || tierKey) + (tierKey === activeTier ? ' ★ Recommended for your PC' : '');
        catalogList.appendChild(groupTitle);

        const items = Array.isArray(tierInfo.items) && tierInfo.items.length > 0
          ? tierInfo.items
          : (tierInfo.models || []).map((name) => ({ name, label: name, category: 'coding', size_label: '', description: '' }));

        items.forEach((item) => {
          const isInstalled = installedModelNames.includes(item.name);
          const row = document.createElement('div');
          row.className = 'list-item';

          const main = document.createElement('div');
          main.className = 'list-item-main';

          const title = document.createElement('div');
          title.className = 'list-item-title';
          title.textContent = item.name + (item.size_label ? ' (' + item.size_label + ')' : '');

          const meta = document.createElement('div');
          meta.className = 'list-item-meta';
          meta.textContent = item.description || item.label || '';

          main.append(title, meta);

          const actions = document.createElement('div');
          actions.className = 'list-item-actions';
          if (item.category) {
            const tag = document.createElement('span');
            tag.className = 'cat-tag';
            tag.textContent = item.category;
            actions.appendChild(tag);
          }

          if (isInstalled) {
            const installedBtn = createBtn(item.name === selectedModelName ? 'Active' : 'Use', 'btn btn-sm btn-secondary', () => {
              vscode.postMessage({ type: 'selectModel', model: item.name });
            });
            actions.appendChild(installedBtn);
          } else {
            const pullBtn = createBtn('Pull', 'btn btn-sm', () => {
              vscode.postMessage({ type: 'pullModel', model: item.name });
            });
            actions.appendChild(pullBtn);
          }

          row.append(main, actions);
          catalogList.appendChild(row);
        });
      });
    }

    function renderHistoryList(sessions, activeId) {
      historyList.innerHTML = '';
      if (!sessions || sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'list-item-meta';
        empty.textContent = 'No saved chats yet.';
        historyList.appendChild(empty);
        return;
      }
      sessions.forEach((s) => {
        const isActive = s.id === activeId;
        const row = document.createElement('div');
        row.className = 'list-item' + (isActive ? ' active' : '');

        const main = document.createElement('div');
        main.className = 'list-item-main';
        main.onclick = () => vscode.postMessage({ type: 'switchSession', sessionId: s.id });

        const title = document.createElement('div');
        title.className = 'list-item-title';
        title.textContent = s.title || 'New Chat';

        const meta = document.createElement('div');
        meta.className = 'list-item-meta';
        meta.textContent = (s.messageCount || 0) + ' messages';

        main.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'list-item-actions';
        actions.appendChild(createBtn('Rename', 'btn btn-sm btn-secondary', () => {
          vscode.postMessage({ type: 'renameSession', sessionId: s.id });
        }));
        actions.appendChild(createBtn('Delete', 'btn btn-sm btn-danger', () => {
          vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
        }));

        row.append(main, actions);
        historyList.appendChild(row);
      });
    }

    function renderSession(session) {
      if (!session) return;
      currentSessionId = session.id;
      sessionTitleText.textContent = session.title || 'New Chat';
      setModeStateOnly(session.mode || 'learn');

      chatStream.innerHTML = '';
      codeBlockStore.clear();
      streamBuffer = '';
      streamingMsgId = '';
      setStreamingUi(false);

      if (!session.messages || session.messages.length === 0) {
        const welcome = document.createElement('div');
        welcome.className = 'empty-state';
        welcome.innerHTML =
          '<h2>LocalDev AI</h2>' +
          '<p>Private local coding assistant powered by Ollama. Ask questions, debug tracebacks, or switch to Edit mode for safe diffs.</p>' +
          '<div class="starter-prompts">' +
          '<button class="starter-chip" data-prompt="Explain what the active file does">Explain active file</button>' +
          '<button class="starter-chip" data-prompt="Review my selection for bugs or edge cases">Find bugs in selection</button>' +
          '<button class="starter-chip" data-prompt="Summarize the workspace structure">Summarize workspace</button>' +
          '</div>';
        chatStream.appendChild(welcome);
        return;
      }

      const startIdx = Math.max(0, session.messages.length - maxRenderedMessages);
      session.messages.slice(startIdx).forEach((m) => appendMessage(m));
    }

    function setModeStateOnly(mode) {
      currentMode = mode === 'edit' ? 'edit' : 'learn';
      modeLearnBtn.classList.toggle('active', currentMode === 'learn');
      modeEditBtn.classList.toggle('active', currentMode === 'edit');
    }

    function removeEmptyState() {
      const empty = chatStream.querySelector('.empty-state');
      if (empty) empty.remove();
    }

    function appendMessage(msg) {
      const el = document.createElement('div');
      el.id = msg.id;
      el.className = 'chat-message ' + (msg.role === 'user' ? 'user-message' : (msg.role === 'system' ? 'system-message' : 'assistant-message'));

      const header = document.createElement('div');
      header.className = 'msg-header';
      header.textContent = msg.role === 'user' ? 'You' : (msg.role === 'system' ? 'Context Observation' : 'LocalDev AI');

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.innerHTML = renderMarkdown(msg.content, msg.id);

      if (msg.crudActions && msg.crudActions.length > 0) {
        msg.crudActions.forEach((a) => bubble.appendChild(createCrudCardElement(a)));
      }

      el.append(header, bubble);

      if (msg.stats) {
        el.appendChild(createStatsRow(msg.stats));
      }

      chatStream.appendChild(el);
      trimRenderedMessages();
      chatStream.scrollTop = chatStream.scrollHeight;
    }

    function createStatsRow(stats) {
      const row = document.createElement('div');
      row.className = 'msg-telemetry';
      const parts = [];
      if (stats.tokens_per_second) parts.push(stats.tokens_per_second + ' tok/s');
      if (stats.ttft_ms) parts.push('TTFT ' + stats.ttft_ms + 'ms');
      if (stats.execution_mode) parts.push(stats.execution_mode);
      row.textContent = parts.join(' · ');
      return row;
    }

    function trimRenderedMessages() {
      while (chatStream.children.length > maxRenderedMessages) {
        chatStream.removeChild(chatStream.firstElementChild);
      }
    }

    function setStreamingUi(streaming) {
      isStreaming = streaming;
      sendBtn.style.display = streaming ? 'none' : 'inline-flex';
      stopBtn.style.display = streaming ? 'inline-flex' : 'none';
      if (streaming) {
        telemetrySpeed.textContent = 'Generating...';
      }
    }

    function startStream(id) {
      setStreamingUi(true);
      streamBuffer = '';
      streamingMsgId = id;

      const el = document.createElement('div');
      el.id = id;
      el.className = 'chat-message assistant-message';

      const header = document.createElement('div');
      header.className = 'msg-header';
      header.textContent = 'LocalDev AI';

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.innerHTML = '<span class="streaming-cursor">▋</span>';

      el.append(header, bubble);
      chatStream.appendChild(el);
      trimRenderedMessages();
      chatStream.scrollTop = chatStream.scrollHeight;
    }

    function appendStreamToken(id, text) {
      if (id !== streamingMsgId) return;
      streamBuffer += text;
      const el = document.getElementById(id);
      const bubble = el ? el.querySelector('.chat-bubble') : null;
      if (bubble) {
        bubble.innerHTML = renderMarkdown(streamBuffer, id) + ' <span class="streaming-cursor">▋</span>';
        chatStream.scrollTop = chatStream.scrollHeight;
      }
    }

    function finishStream(id, content, crudActions, stats) {
      setStreamingUi(false);
      streamBuffer = '';
      streamingMsgId = '';

      if (stats) {
        telemetrySpeed.textContent = (stats.tokens_per_second || 0) + ' tok/s · TTFT ' + (stats.ttft_ms || 0) + 'ms';
        if (stats.execution_mode) {
          telemetryExec.textContent = stats.execution_mode + (stats.num_ctx ? ' · ctx ' + stats.num_ctx : '');
        }
        if (stats.ram_available_bytes) {
          telemetryRam.textContent = 'RAM: ' + (stats.ram_available_bytes / (1024 ** 3)).toFixed(1) + ' GiB free';
        }
      } else {
        telemetrySpeed.textContent = 'Ready';
      }

      const el = document.getElementById(id);
      if (el) {
        const bubble = el.querySelector('.chat-bubble');
        if (bubble) {
          bubble.innerHTML = renderMarkdown(content, id);
          if (crudActions && crudActions.length > 0) {
            crudActions.forEach((a) => bubble.appendChild(createCrudCardElement(a)));
          }
        }
        if (stats) {
          el.appendChild(createStatsRow(stats));
        }
      }
      trimRenderedMessages();
      chatStream.scrollTop = chatStream.scrollHeight;
    }

    function cancelStream(id) {
      setStreamingUi(false);
      telemetrySpeed.textContent = 'Stopped';
      const el = document.getElementById(id);
      if (el) {
        const bubble = el.querySelector('.chat-bubble');
        if (bubble) {
          if (streamBuffer.trim()) {
            bubble.innerHTML = renderMarkdown(streamBuffer, id) + '<br><em>(Stopped)</em>';
          } else {
            el.remove();
          }
        }
      }
      streamBuffer = '';
      streamingMsgId = '';
    }

    // Safe Markdown renderer: extracts fenced code blocks BEFORE HTML-escaping or inline formatting
    function renderMarkdown(rawText, msgId) {
      if (!rawText) return '';
      const normalized = String(rawText).replace(/\\r\\n/g, '\\n');
      const bt = String.fromCharCode(96);
      const fence = bt + bt + bt;
      const fenceRegex = new RegExp(fence + '([a-zA-Z0-9_.\\\\-]+)?[ \\\\t]*\\\\n([\\\\s\\\\S]*?)(?:\\\\n' + fence + '|' + fence + '|$)', 'g');

      const blocks = [];
      const withPlaceholders = normalized.replace(fenceRegex, (_m, lang, code) => {
        const cleanCode = code.replace(/\\n$/, '');
        const key = (msgId || 'msg') + ':' + blocks.length;
        codeBlockStore.set(key, cleanCode);
        blocks.push({ key, lang: lang || 'code', code: cleanCode });
        return '\\n@@CODEBLOCK_' + (blocks.length - 1) + '@@\\n';
      });

      let html = escapeHtml(withPlaceholders);
      const inlineCodeRegex = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
      html = html.replace(inlineCodeRegex, '<code class="inline-code">$1</code>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|[^\\*])\\*([^\\*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
      html = html.replace(/^### (.*)$/gm, '<h4 style="margin:6px 0 2px;">$1</h4>');
      html = html.replace(/^## (.*)$/gm, '<h3 style="margin:8px 0 3px;">$1</h3>');
      html = html.replace(/^# (.*)$/gm, '<h2 style="margin:10px 0 4px;">$1</h2>');
      html = html.replace(/\\n/g, '<br>');

      blocks.forEach((b, idx) => {
        const blockHtml =
          '<div class="code-container">' +
          '<div class="code-header">' +
          '<span>' + escapeHtml(b.lang) + '</span>' +
          '<div class="code-actions">' +
          '<button class="code-btn copy-btn" data-block-key="' + escapeHtml(b.key) + '">Copy</button>' +
          '<button class="code-btn insert-btn" data-block-key="' + escapeHtml(b.key) + '">Insert</button>' +
          '</div></div>' +
          '<pre class="code-pre"><code>' + escapeHtml(b.code) + '</code></pre>' +
          '</div>';
        const token = '@@CODEBLOCK_' + idx + '@@';
        html = html.replace('<br>' + token + '<br>', blockHtml);
        html = html.replace(token + '<br>', blockHtml);
        html = html.replace('<br>' + token, blockHtml);
        html = html.replace(token, blockHtml);
      });

      return html;
    }

    // Event delegation on chatStream: avoids duplicate listeners across streaming updates
    chatStream.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      const starter = target.closest('.starter-chip');
      if (starter) {
        const p = starter.getAttribute('data-prompt') || '';
        promptInput.value = p;
        promptInput.focus();
        promptInput.dispatchEvent(new Event('input'));
        return;
      }

      const copyBtn = target.closest('.copy-btn');
      if (copyBtn) {
        const key = copyBtn.getAttribute('data-block-key') || '';
        const code = codeBlockStore.get(key) || '';
        if (code) {
          navigator.clipboard?.writeText(code);
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
        }
        return;
      }

      const insertBtn = target.closest('.insert-btn');
      if (insertBtn) {
        const key = insertBtn.getAttribute('data-block-key') || '';
        const code = codeBlockStore.get(key) || '';
        if (code) {
          vscode.postMessage({ type: 'insertCode', code, mode: 'insert' });
        }
        return;
      }

      const approveBtn = target.closest('.crud-approve-btn');
      if (approveBtn) {
        const id = approveBtn.getAttribute('data-action-id') || '';
        approveBtn.setAttribute('disabled', 'true');
        vscode.postMessage({ type: 'applyCrudAction', id });
        return;
      }

      const rejectBtn = target.closest('.crud-reject-btn');
      if (rejectBtn) {
        const id = rejectBtn.getAttribute('data-action-id') || '';
        rejectBtn.setAttribute('disabled', 'true');
        vscode.postMessage({ type: 'rejectCrudAction', id });
      }
    });

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

      header.append(badge, pathSpan);
      card.appendChild(header);

      if (action.explanation) {
        const exp = document.createElement('div');
        exp.className = 'list-item-meta';
        exp.textContent = action.explanation;
        card.appendChild(exp);
      }

      if (action.diff) {
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = 'Diff preview';
        const preview = document.createElement('div');
        preview.className = 'crud-diff-preview';
        preview.innerHTML = action.diff.split('\\n').map((line) => {
          if (line.startsWith('+') && !line.startsWith('+++')) return '<span class="diff-line-add">' + escapeHtml(line) + '</span>';
          if (line.startsWith('-') && !line.startsWith('---')) return '<span class="diff-line-del">' + escapeHtml(line) + '</span>';
          if (line.startsWith('@@')) return '<span class="diff-line-info">' + escapeHtml(line) + '</span>';
          return escapeHtml(line);
        }).join('\\n');
        details.append(summary, preview);
        card.appendChild(details);
      } else if (action.content) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Content preview';
        const preview = document.createElement('div');
        preview.className = 'crud-diff-preview';
        preview.textContent = action.content.slice(0, 400) + (action.content.length > 400 ? '\\n...' : '');
        details.append(summary, preview);
        card.appendChild(details);
      }

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'crud-actions';
      renderCrudActionControls(actionsDiv, action);
      card.appendChild(actionsDiv);
      return card;
    }

    function renderCrudActionControls(container, action) {
      container.innerHTML = '';
      if (action.status === 'pending' && action.action !== 'read') {
        const approveBtn = document.createElement('button');
        approveBtn.className = 'btn btn-sm crud-approve-btn';
        approveBtn.setAttribute('data-action-id', action.id);
        approveBtn.textContent = '✓ Approve / Apply';

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn btn-sm btn-secondary crud-reject-btn';
        rejectBtn.setAttribute('data-action-id', action.id);
        rejectBtn.textContent = '✕ Reject';

        container.append(approveBtn, rejectBtn);
      } else if (action.status === 'failed' && action.action !== 'read') {
        const errSpan = document.createElement('span');
        errSpan.style.fontSize = '10px';
        errSpan.style.color = 'var(--err)';
        errSpan.textContent = 'Failed: ' + (action.error || 'Unknown error');

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-sm btn-secondary crud-approve-btn';
        retryBtn.setAttribute('data-action-id', action.id);
        retryBtn.textContent = 'Retry';

        container.append(errSpan, retryBtn);
      } else {
        const statusSpan = document.createElement('span');
        statusSpan.style.fontSize = '10px';
        statusSpan.style.color = action.status === 'applied' ? 'var(--ok)' : (action.status === 'rejected' ? 'var(--muted)' : 'var(--err)');
        statusSpan.textContent = action.status === 'applied'
          ? (action.action === 'read' ? 'File read into context' : '✓ Applied')
          : (action.status === 'rejected' ? 'Rejected' : 'Failed: ' + (action.error || ''));
        container.appendChild(statusSpan);
      }
    }

    function updateCrudCard(action) {
      const card = document.getElementById(action.id);
      if (card) {
        const actionsDiv = card.querySelector('.crud-actions');
        if (actionsDiv) renderCrudActionControls(actionsDiv, action);
      }
    }

    function updateEditorContext(editor) {
      if (editor) {
        activeFileChip.style.display = 'inline-flex';
        activeFileLabel.textContent = editor.path + (editor.lineRange ? ' (' + editor.lineRange + ')' : '');
      } else {
        activeFileChip.style.display = 'none';
      }
    }

    function updateContextChips(files) {
      document.querySelectorAll('.attached-file-chip').forEach((el) => el.remove());
      files.forEach((f) => {
        const chip = document.createElement('span');
        chip.className = 'chip attached-file-chip';
        chip.textContent = f + ' ';
        const rm = document.createElement('span');
        rm.className = 'chip-remove';
        rm.textContent = '×';
        rm.onclick = () => vscode.postMessage({ type: 'removeFileContext', path: f });
        chip.appendChild(rm);
        attachFileBtn.parentNode.insertBefore(chip, attachFileBtn);
      });
    }

    function renderMentionPopup(results) {
      mentionPopup.innerHTML = '';
      if (!results || results.length === 0) {
        mentionPopup.style.display = 'none';
        return;
      }
      results.forEach((filePath) => {
        const item = document.createElement('div');
        item.className = 'mention-item';
        item.textContent = filePath;
        item.onclick = () => {
          const val = promptInput.value;
          const cursor = promptInput.selectionStart || val.length;
          const before = val.slice(0, cursor).replace(/@([a-zA-Z0-9_\\.\\-/\\\\]*)$/, '@' + filePath + ' ');
          const after = val.slice(cursor);
          promptInput.value = before + after;
          mentionPopup.style.display = 'none';
          promptInput.focus();
        };
        mentionPopup.appendChild(item);
      });
      mentionPopup.style.display = 'block';
    }

    function createBtn(text, cls, onClick) {
      const btn = document.createElement('button');
      btn.className = cls;
      btn.textContent = text;
      btn.onclick = onClick;
      return btn;
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
