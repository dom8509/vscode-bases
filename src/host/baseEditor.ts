// The custom editor for .base files. The .base text document is the source of
// truth for the view configuration; the webview renders the computed view and
// sends edits back.

import * as vscode from "vscode";
import { computeView, DEFAULT_PAGE_SIZE, parseBase } from "../core/base";
import { updateBase, type BaseOp } from "../core/baseEdit";
import { parseInputValue, textChange, type PropertyEdit } from "../core/writer";
import type { FromWebview, ToWebview, UiEdit, UiState } from "../protocol";
import { applyPropertyEdits } from "./edits";
import { fileInfo, type WorkspaceIndex } from "./indexer";

export const VIEW_TYPE = "bases.editor";

function toPropertyEdit(e: UiEdit): PropertyEdit {
  if (e.kind === "set") return { kind: "set", key: e.key, value: parseInputValue(e.input) };
  if (e.kind === "setValue") return { kind: "set", key: e.key, value: e.value };
  return e;
}

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export class BaseEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly index: WorkspaceIndex,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist"), vscode.Uri.joinPath(this.context.extensionUri, "webview")] };
    webview.html = this.html(webview);

    // What the person is looking at is UI state, not part of the base file.
    const ui: UiState = {
      viewIndex: 0,
      page: 0,
      pageSize: vscode.workspace.getConfiguration("bases").get<number>("pageSize", DEFAULT_PAGE_SIZE),
      query: "",
    };
    let ready = false;
    const post = (msg: ToWebview) => void webview.postMessage(msg);

    const render = async () => {
      if (!ready) return;
      let base;
      try {
        base = parseBase(document.getText());
      } catch (e) {
        post({ type: "error", message: `This base cannot be read: ${(e as Error).message}` });
        return;
      }
      await this.index.ensureReady();
      const stat = document.uri.scheme === "file" ? await vscode.workspace.fs.stat(document.uri).then(undefined, () => undefined) : undefined;
      const result = computeView(base, this.index.all(), {
        ...ui,
        thisFile: stat ? fileInfo(document.uri, stat) : undefined,
      });
      ui.viewIndex = result.viewIndex;
      ui.page = result.page;
      post({ type: "render", result });
    };

    let timer: NodeJS.Timeout | undefined;
    const scheduleRender = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void render(), 50);
    };

    const applyBaseOps = async (ops: BaseOp[]) => {
      const text = document.getText();
      const change = textChange(text, updateBase(text, ops));
      if (!change) return;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
      await vscode.workspace.applyEdit(edit);
      // Follow the view the person just made, or stay next to the one removed.
      for (const op of ops) {
        if (op.op === "addView") ui.viewIndex = parseBase(document.getText()).views.length - 1;
        if (op.op === "duplicateView") ui.viewIndex = op.index + 1;
        if (op.op === "removeView" && op.index <= ui.viewIndex) ui.viewIndex = Math.max(0, ui.viewIndex - 1);
        if (op.op === "addView" || op.op === "duplicateView" || op.op === "removeView") ui.page = 0;
      }
      scheduleRender();
    };

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) scheduleRender();
      }),
      this.index.onDidChange(scheduleRender),
      webview.onDidReceiveMessage(async (msg: FromWebview) => {
        switch (msg.type) {
          case "ready":
            ready = true;
            await render();
            break;
          case "ui":
            // Another view or another search starts on the first page.
            if ((msg.state.viewIndex !== undefined && msg.state.viewIndex !== ui.viewIndex) || (msg.state.query !== undefined && msg.state.query !== ui.query)) ui.page = 0;
            Object.assign(ui, msg.state);
            await render();
            break;
          case "baseOps":
            try {
              await applyBaseOps(msg.ops);
            } catch (e) {
              post({ type: "notice", message: (e as Error).message });
            }
            break;
          case "open":
            await vscode.window.showTextDocument(vscode.Uri.parse(msg.uri), { preview: true, viewColumn: vscode.ViewColumn.Beside });
            break;
          case "openAsText":
            await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
            break;
          case "edit": {
            const outcome = await applyPropertyEdits(msg.uris.map((u) => vscode.Uri.parse(u)), msg.edits.map(toPropertyEdit));
            if (outcome.failures.length > 0) {
              void vscode.window.showWarningMessage(`${outcome.failures.length} file(s) not changed: ${outcome.failures.slice(0, 3).join("; ")}`);
            }
            if (outcome.applied) post({ type: "notice", message: `${outcome.changed} file(s) changed` });
            break;
          }
        }
      }),
    ];

    panel.onDidDispose(() => {
      clearTimeout(timer);
      for (const s of subscriptions) s.dispose();
    });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "webview", "style.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Base</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }
}
