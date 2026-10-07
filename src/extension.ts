import * as vscode from "vscode";
import { NEW_BASE } from "./core/baseEdit";
import { BaseEditorProvider, VIEW_TYPE } from "./host/baseEditor";
import { WorkspaceIndex } from "./host/indexer";

export function activate(context: vscode.ExtensionContext): void {
  const index = new WorkspaceIndex();
  context.subscriptions.push(
    index,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new BaseEditorProvider(context, index), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("bases.newBase", async (target?: vscode.Uri) => newBase(target)),
    vscode.commands.registerCommand("bases.openAsText", async (target?: vscode.Uri) => {
      const uri = target ?? activeBaseUri();
      if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    }),
  );
}

function activeBaseUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  return input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
}

async function newBase(target?: vscode.Uri): Promise<void> {
  const folder = target ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    void vscode.window.showErrorMessage("Open a folder first: a base indexes the files of the workspace.");
    return;
  }
  const name = await vscode.window.showInputBox({ prompt: "Name of the new base", value: "Untitled" });
  if (!name) return;
  const uri = vscode.Uri.joinPath(folder, name.endsWith(".base") ? name : `${name}.base`);
  try {
    await vscode.workspace.fs.stat(uri);
    void vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(uri)} already exists.`);
    return;
  } catch {
    // Does not exist yet: create it.
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(NEW_BASE));
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
}

export function deactivate(): void {}
