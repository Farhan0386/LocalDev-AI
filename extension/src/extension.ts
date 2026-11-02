import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'localdev-ai.helloWorld',
    () => {
      void vscode.window.showInformationMessage('Hello World from LocalDev AI!');
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
