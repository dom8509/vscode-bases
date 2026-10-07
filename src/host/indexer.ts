// Keeps a record of every Markdown and YAML file in the workspace, current
// with the file system and with unsaved changes in open editors.

import * as vscode from "vscode";
import type { FileInfo } from "../core/expr";
import { parseRecord, sourceKind, type FileRecord } from "../core/record";

export function fileInfo(uri: vscode.Uri, stat: { mtime: number; ctime: number; size: number }): FileInfo {
  const path = vscode.workspace.asRelativePath(uri, vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 1);
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    mtime: stat.mtime,
    ctime: stat.ctime,
    size: stat.size,
  };
}

function excludeGlob(): string | undefined {
  const own = vscode.workspace.getConfiguration("bases").get<string[]>("exclude", []);
  const files = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude", {});
  const globs = [...own, ...Object.entries(files).filter(([, on]) => on).map(([g]) => g)];
  if (globs.length === 0) return undefined;
  return globs.length === 1 ? globs[0] : `{${globs.join(",")}}`;
}

export class WorkspaceIndex implements vscode.Disposable {
  private readonly records = new Map<string, FileRecord>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private ready: Promise<void> | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  /** Fires, debounced, after records were added, changed or removed. */
  readonly onDidChange = this.changed.event;

  /** Indexes the workspace on first use and resolves when that is done. */
  ensureReady(): Promise<void> {
    this.ready ??= this.start();
    return this.ready;
  }

  all(): Iterable<FileRecord> {
    return this.records.values();
  }

  get(uri: vscode.Uri): FileRecord | undefined {
    return this.records.get(uri.toString());
  }

  private async start(): Promise<void> {
    const include = vscode.workspace.getConfiguration("bases").get<string>("include", "**/*.{md,markdown,yml,yaml}");
    const uris = await vscode.workspace.findFiles(include, excludeGlob());
    // Read in batches so a large workspace does not open thousands of files at once.
    for (let i = 0; i < uris.length; i += 64) {
      await Promise.all(uris.slice(i, i + 64).map((u) => this.load(u)));
    }

    const watcher = vscode.workspace.createFileSystemWatcher(include);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.schedule(u)),
      watcher.onDidChange((u) => this.schedule(u)),
      watcher.onDidDelete((u) => {
        this.records.delete(u.toString());
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.records.has(e.document.uri.toString())) this.schedule(e.document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bases") || e.affectsConfiguration("files.exclude")) void this.reset();
      }),
    );
  }

  private async reset(): Promise<void> {
    for (const d of this.disposables.splice(1)) d.dispose();
    this.records.clear();
    this.ready = this.start();
    await this.ready;
    this.changed.fire();
  }

  private schedule(uri: vscode.Uri): void {
    this.pending.add(uri.toString());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 150);
  }

  private async flush(): Promise<void> {
    const uris = [...this.pending].map((s) => vscode.Uri.parse(s));
    this.pending.clear();
    await Promise.all(uris.map((u) => this.load(u)));
    this.changed.fire();
  }

  private async load(uri: vscode.Uri): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const info = fileInfo(uri, stat);
      if (!sourceKind(info.ext)) return;
      // An open editor may hold changes that are not on disk yet.
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const record = parseRecord(uri.toString(), info, text);
      if (record) this.records.set(uri.toString(), record);
    } catch {
      this.records.delete(uri.toString());
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
