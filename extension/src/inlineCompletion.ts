import * as vscode from 'vscode';
import { PythonEngine } from './pythonEngine';

export class LocalDevInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private _enabled = true;
  private _debounceTimer?: NodeJS.Timeout;
  private _activeCts?: vscode.CancellationTokenSource;

  constructor(private readonly _engineGetter: () => PythonEngine | undefined) {}

  public isEnabled(): boolean {
    return this._enabled;
  }

  public setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | undefined> {
    if (!this._enabled) {
      return undefined;
    }

    // Abort if line is already at end of file and empty or only whitespace before
    const lineText = document.lineAt(position.line).text;
    const prefixOnLine = lineText.substring(0, position.character);

    // Cancel any ongoing completion request
    if (this._activeCts) {
      this._activeCts.cancel();
      this._activeCts.dispose();
      this._activeCts = undefined;
    }

    // Debounce to avoid flooding on fast typing
    await new Promise<void>((resolve) => {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(resolve, 500);
      token.onCancellationRequested(() => {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        resolve();
      });
    });

    if (token.isCancellationRequested) {
      return undefined;
    }

    const engine = this._engineGetter();
    if (!engine) {
      return undefined;
    }

    const config = vscode.workspace.getConfiguration('localdev-ai');
    const model = config.get<string>('selectedModel', '').trim();
    if (!model) {
      return undefined;
    }

    // Build bounded prefix and suffix
    const startLine = Math.max(0, position.line - 35);
    const endLine = Math.min(document.lineCount - 1, position.line + 20);

    const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
    const suffixRange = new vscode.Range(
      position.line,
      position.character,
      endLine,
      document.lineAt(endLine).text.length,
    );

    const prefix = document.getText(prefixRange);
    const suffix = document.getText(suffixRange);

    if (!prefix.trim()) {
      return undefined;
    }

    this._activeCts = new vscode.CancellationTokenSource();
    token.onCancellationRequested(() => {
      this._activeCts?.cancel();
    });

    try {
      const response = await engine.request(
        'inline_complete',
        {
          ollama_endpoint: config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
          ollama_timeout_seconds: 5,
          model,
          prefix,
          suffix,
          max_tokens: 64,
          temperature: 0.1,
        },
        undefined,
        this._activeCts.token,
      );

      if (token.isCancellationRequested) {
        return undefined;
      }

      let completionText = typeof response.message === 'string' ? response.message : '';
      if (!completionText.trim()) {
        return undefined;
      }

      // Avoid repeating characters already typed on current line
      if (completionText.startsWith(prefixOnLine)) {
        completionText = completionText.substring(prefixOnLine.length);
      }

      const item = new vscode.InlineCompletionItem(
        completionText,
        new vscode.Range(position, position),
      );

      return [item];
    } catch {
      return undefined;
    } finally {
      this._activeCts?.dispose();
      this._activeCts = undefined;
    }
  }
}
