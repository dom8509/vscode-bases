// Reads the links between files from the project's SQLite database
// (`bases.links.database`) with the project's own query (`bases.links.query`),
// and reads them again when the database or the settings change.
//
// The database is read into memory and only queried there: the file itself is
// never opened for writing, and the query cannot change it.

import * as path from "node:path";
import * as vscode from "vscode";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { LinkGraph, makeResolver, readLinks, type LinkRow } from "../core/links";
import type { WorkspaceIndex } from "./indexer";

export const DEFAULT_LINK_QUERY = "SELECT source, target, type FROM links";

export class LinkSource implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private watchers: vscode.Disposable[] = [];
  private sql: Promise<SqlJsStatic> | undefined;
  private rows: LinkRow[] = [];
  private error: string | undefined;
  private file: vscode.Uri | undefined;
  private graph: LinkGraph | undefined;
  private graphPaths = -1;
  private timer: NodeJS.Timeout | undefined;
  private loading = 0;

  /** Fires after the links were read again. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: WorkspaceIndex,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bases.links")) this.configure();
      }),
    );
    this.configure();
  }

  /** The links, matched to the workspace's files; undefined when no database is set. */
  links(): LinkGraph | undefined {
    if (!this.file) return undefined;
    if (this.error) return new LinkGraph([], undefined, this.error);
    // Paths are matched again when files come or go; while a scan adds files, once it is done.
    const paths = this.index.pathsVersion;
    if (!this.graph || (this.graphPaths !== paths && !this.index.progress)) {
      const root = vscode.workspace.getWorkspaceFolder(this.file)?.uri;
      const dbFolder = root ? path.posix.dirname(path.posix.relative(root.path, this.file.path)) : "";
      const resolve = makeResolver(
        [...this.index.all()].map((r) => r.file.path),
        dbFolder === "." ? "" : dbFolder,
        (abs) => {
          const rel = vscode.workspace.asRelativePath(vscode.Uri.file(abs), (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
          return rel === abs ? undefined : rel;
        },
      );
      this.graph = new LinkGraph(this.rows, resolve);
      this.graphPaths = paths;
    }
    return this.graph;
  }

  private configure(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.file = undefined;
    this.graph = undefined;
    this.rows = [];
    this.error = undefined;
    const setting = vscode.workspace.getConfiguration("bases").get<string>("links.database", "").trim();
    if (setting) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      this.file = path.isAbsolute(setting) || !root ? vscode.Uri.file(setting) : vscode.Uri.joinPath(root, setting);
      // The -wal file changes when another program writes in WAL mode.
      const folder = vscode.Uri.joinPath(this.file, "..");
      const name = path.posix.basename(this.file.path);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${name}{,-wal}`));
      this.watchers.push(watcher, watcher.onDidChange(() => this.loadSoon()), watcher.onDidCreate(() => this.loadSoon()), watcher.onDidDelete(() => this.loadSoon()));
      void this.load();
    }
    this.changed.fire();
  }

  private loadSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), 500);
  }

  private async load(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const run = ++this.loading;
    const query = vscode.workspace.getConfiguration("bases").get<string>("links.query", DEFAULT_LINK_QUERY).trim() || DEFAULT_LINK_QUERY;
    const started = performance.now();
    let rows: LinkRow[] = [];
    let error: string | undefined;
    try {
      this.sql ??= initSqlJs({ locateFile: (f) => vscode.Uri.joinPath(this.extensionUri, "dist", f).fsPath });
      const SQL = await this.sql;
      const bytes = await vscode.workspace.fs.readFile(file);
      rows = readLinks(SQL, bytes, query);
      const wal = await vscode.workspace.fs.stat(vscode.Uri.file(`${file.fsPath}-wal`)).then((s) => s.size, () => 0);
      if (wal > 0) this.log.warn(`${file.fsPath}-wal holds changes not yet written to the database; they show once SQLite writes them (a checkpoint)`);
    } catch (e) {
      error = `Cannot read the links from ${vscode.workspace.asRelativePath(file)}: ${(e as Error).message}`;
    }
    // A newer load started meanwhile: its result wins.
    if (run !== this.loading || file !== this.file) return;
    this.rows = rows;
    this.error = error;
    this.graph = undefined;
    if (error) this.log.error(error);
    else this.log.info(`Read ${rows.length} links from ${vscode.workspace.asRelativePath(file)} in ${Math.round(performance.now() - started)} ms`);
    this.changed.fire();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of [...this.watchers, ...this.disposables]) d.dispose();
  }
}
