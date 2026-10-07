// The custom editor for .base files. The .base text document is the source of
// truth for the view configuration; the webview renders the computed view and
// sends edits back.

import MarkdownIt from "markdown-it";
import * as vscode from "vscode";
import type { Row } from "../core/base";
import { computeView, DEFAULT_PAGE_SIZE, parseBase } from "../core/base";
import { updateBase, type BaseOp } from "../core/baseEdit";
import { nextId } from "../core/autoId";
import { documentMarkdown } from "../core/document";
import { toDelimited } from "../core/export";
import { toXlsx } from "../core/xlsx";
import { bodyText, sourceKind } from "../core/record";
import { newNote, noteText } from "../core/newNote";
import { parseInputValue, textChange, type PropertyEdit } from "../core/writer";
import type { EditTarget, FromWebview, ToWebview, UiEdit, UiState } from "../protocol";
import { applyPropertyEdits } from "./edits";
import { fileInfo, type WorkspaceIndex } from "./indexer";

export const VIEW_TYPE = "bases.editor";

/** The text of a file: what an editor holds, else what is on disk. */
async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** Fills in the Markdown after the frontmatter of each row, for the document layout and its export. */
async function withBodies(rows: Row[]): Promise<void> {
  await Promise.all(rows.map(async (row) => {
    const uri = vscode.Uri.parse(row.uri);
    const kind = sourceKind(uri.path.split(".").pop() ?? "");
    row.body = kind ? bodyText(await readText(uri).catch(() => ""), kind) : "";
  }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A page that reads well and prints well (Print → PDF), and that Word opens. */
function documentHtml(title: string, markdown: string): string {
  const body = new MarkdownIt({ html: false, linkify: true }).render(markdown);
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
body { font: 11pt/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 48em; margin: 2em auto; padding: 0 1em; color: #222; }
h1 { font-size: 1.8em; border-bottom: 1px solid #ccc; padding-bottom: .2em; }
h2, h3 { margin-top: 1.6em; }
h4, h5, h6 { margin: 1.4em 0 .3em; }
p strong { color: #555; font-weight: 600; }
code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; background: #f4f4f4; }
pre { padding: .6em; overflow: auto; }
table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: .2em .5em; }
@media print { body { margin: 0; max-width: none; } h2, h3 { break-after: avoid; } }
</style></head><body>
${body}</body></html>
`;
}

/**
 * Swaps a base between the table and its YAML, as the Markdown preview does:
 * the other editor opens in the same place and the one it replaces closes.
 */
export async function reopenWith(uri: vscode.Uri, viewType: typeof VIEW_TYPE | "default"): Promise<void> {
  const isOld = (tab: vscode.Tab) => {
    const input = tab.input;
    if (viewType === "default") return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === uri.toString();
    return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
  };
  const group = vscode.window.tabGroups.activeTabGroup;
  const old = group.tabs.find(isOld);
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType, group.viewColumn);
  // The text keeps its unsaved changes in the table's document, so closing the tab loses nothing.
  if (old && !old.isDirty) await vscode.window.tabGroups.close(group.tabs.find(isOld) ?? old, true).then(undefined, () => undefined);
}

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
    private readonly log: vscode.LogOutputChannel,
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
      const started = performance.now();
      const result = computeView(base, this.index.all(), { ...ui, thisFile: await thisFile() });
      ui.viewIndex = result.viewIndex;
      ui.page = result.page;
      this.log.debug(`${vscode.workspace.asRelativePath(document.uri)} › ${result.view.name}: ${result.matchCount} of ${result.total} files, page ${result.page + 1}, in ${Math.round(performance.now() - started)} ms`);
      if (result.view.type === "document") await withBodies(result.rows);
      post({ type: "render", result, indexing: this.index.progress && { ...this.index.progress } });
    };

    const thisFile = async () => {
      const stat = document.uri.scheme === "file" ? await vscode.workspace.fs.stat(document.uri).then(undefined, () => undefined) : undefined;
      return stat ? fileInfo(document.uri, stat) : undefined;
    };

    /** The files an edit applies to; "all matching" is resolved against the view as it is now. */
    const resolveTarget = async (target: EditTarget): Promise<vscode.Uri[]> => {
      if ("uris" in target) return target.uris.map((u) => vscode.Uri.parse(u));
      const result = computeView(parseBase(document.getText()), this.index.all(), { ...ui, thisFile: await thisFile(), collectUris: true });
      const except = new Set(target.except);
      return (result.allUris ?? []).filter((u) => !except.has(u)).map((u) => vscode.Uri.parse(u));
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
        if (op.op === "moveView") {
          if (op.index === ui.viewIndex) ui.viewIndex = op.to;
          else if (op.index < ui.viewIndex && op.to >= ui.viewIndex) ui.viewIndex--;
          else if (op.index > ui.viewIndex && op.to <= ui.viewIndex) ui.viewIndex++;
        }
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
            // A link in a note's text: the browser opens it.
            if (/^https?:/i.test(msg.uri)) {
              await vscode.env.openExternal(vscode.Uri.parse(msg.uri));
              break;
            }
            await vscode.window.showTextDocument(vscode.Uri.parse(msg.uri), { preview: true, viewColumn: vscode.ViewColumn.Beside });
            break;
          case "newNote":
            await this.createNote(document, ui.viewIndex, post);
            break;
          case "export": {
            const all = computeView(parseBase(document.getText()), this.index.all(), { ...ui, page: 0, pageSize: Number.MAX_SAFE_INTEGER, thisFile: await thisFile() });
            const files = `${all.rows.length} ${all.rows.length === 1 ? "row" : "rows"}`;
            if (msg.to === "clipboard") {
              await vscode.env.clipboard.writeText(toDelimited(all.columns, all.rows, "\t"));
              post({ type: "notice", message: `Copied ${files} to the clipboard` });
              break;
            }
            const baseName = document.uri.path.split("/").pop()!.replace(/\.base$/, "");
            const ext = { csv: "csv", xlsx: "xlsx", markdown: "md", html: "html" }[msg.to];
            const name = `${baseName} - ${all.view.name}.${ext}`.replace(/[\\/:*?"<>|]/g, "_");
            const filters: Record<string, string[]> = { csv: { CSV: ["csv"] }, xlsx: { Excel: ["xlsx"] }, md: { Markdown: ["md"] }, html: { HTML: ["html"] } }[ext]!;
            const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(document.uri, "..", name), filters });
            if (!target) break;
            let out: string | Uint8Array;
            if (msg.to === "xlsx") {
              // A grouped table keeps its groups as the first column, so Excel can filter by them.
              const g = all.group;
              const columns = g && !all.columns.some((c) => c.id === g.id) ? [g, ...all.columns] : all.columns;
              out = toXlsx(columns, all.rows, all.view.name);
            } else if (msg.to === "csv") {
              // The BOM lets Excel read the file as UTF-8.
              out = `\uFEFF${toDelimited(all.columns, all.rows, ",")}`;
            } else {
              await withBodies(all.rows);
              const markdown = documentMarkdown(`${baseName} – ${all.view.name}`, all.columns, all.rows, all.group);
              out = msg.to === "markdown" ? markdown : documentHtml(`${baseName} – ${all.view.name}`, markdown);
            }
            await vscode.workspace.fs.writeFile(target, typeof out === "string" ? new TextEncoder().encode(out) : out);
            post({ type: "notice", message: `Exported ${files} to ${vscode.workspace.asRelativePath(target)}` });
            break;
          }
          case "edit": {
            const confirm = !msg.confirmed && vscode.workspace.getConfiguration("bases").get<boolean>("confirmBulkEdits", true);
            const outcome = await applyPropertyEdits(await resolveTarget(msg.target), msg.edits.map(toPropertyEdit), { confirm });
            for (const f of outcome.failures) this.log.warn(`Not changed: ${f}`);
            if (outcome.failures.length > 0) {
              void vscode.window.showWarningMessage(`${outcome.failures.length} file(s) not changed: ${outcome.failures.slice(0, 3).join("; ")}${outcome.failures.length > 3 ? " … (all in the Bases output)" : ""}`);
            }
            if (outcome.concurrent.length > 0) {
              void vscode.window.showWarningMessage(`Something else changed ${outcome.concurrent.length} file(s) while they were edited; check them: ${outcome.concurrent.slice(0, 3).join(", ")}`);
            }
            if (outcome.applied) post({ type: "notice", message: `${outcome.changed} file(s) changed` });
            // A cell shows its new value at once; a render puts back the truth if the edit did not happen.
            if (!outcome.applied) scheduleRender();
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

  /** Asks for a name, writes the note in the folder of `bases.newNoteFolder` (or the view's), and opens it. */
  private async createNote(document: vscode.TextDocument, viewIndex: number, post: (msg: ToWebview) => void): Promise<void> {
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      post({ type: "notice", message: "Open a folder first: a new note goes into the workspace." });
      return;
    }
    const base = parseBase(document.getText());
    const note = newNote(base, viewIndex);
    // A column of IDs like REQ-041 gives the new note the next one (and its name); "id" is looked at first.
    const all = computeView(base, this.index.all(), { viewIndex, page: 0, pageSize: Number.MAX_SAFE_INTEGER });
    const candidates = all.columns.filter((c) => c.editable).sort((a, b) => Number(b.id.toLowerCase() === "id") - Number(a.id.toLowerCase() === "id"));
    let id: string | undefined;
    for (const c of candidates) {
      id = nextId(all.rows.map((r) => r.cells[c.id]));
      if (id) {
        note.properties = { [c.id]: id, ...note.properties };
        break;
      }
    }
    const setting = vscode.workspace.getConfiguration("bases").get<string>("newNoteFolder", "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
    const folderPath = note.folder ?? setting;
    const folder = folderPath ? vscode.Uri.joinPath(root, ...folderPath.split(/[/\\]/)) : root;

    const exists = (uri: vscode.Uri) => vscode.workspace.fs.stat(uri).then(() => true, () => false);
    const fileFor = (name: string) => vscode.Uri.joinPath(folder, /\.(md|markdown)$/i.test(name) ? name : `${name}.md`);
    let suggestion = id ?? "Untitled";
    for (let i = 2; await exists(fileFor(suggestion)); i++) suggestion = `${id ?? "Untitled"} ${i}`;
    const where = folderPath ? `${folderPath}/` : "the workspace folder";
    const name = await vscode.window.showInputBox({
      title: "New note",
      prompt: `Name of the note, in ${where}`,
      value: suggestion,
      validateInput: async (v) => {
        if (!v.trim()) return "Give the note a name.";
        if (/[\\/:*?"<>|]/.test(v)) return "A name cannot contain \\ / : * ? \" < > |";
        return (await exists(fileFor(v.trim()))) ? `${v.trim()} already exists.` : undefined;
      },
    });
    if (!name) return;
    const uri = fileFor(name.trim());
    await vscode.workspace.fs.createDirectory(folder);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(noteText(note.properties)));
    await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
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
