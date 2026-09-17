import * as vscode from 'vscode'
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('agentImessage.openSettings', () => vscode.env.openExternal(vscode.Uri.parse('http://127.0.0.1:8787'))))
}
export function deactivate(): void {}
