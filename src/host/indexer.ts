// Keeps a record of every Markdown and YAML file in the workspace, current
// with the file system and with unsaved changes in open editors.
//
// What parsing produced is cached per workspace. On start the cached records
// are shown at once; a scan then stats every file and reads only the ones
// whose mtime or size changed, and drops the ones that are gone.

import * as vscode from "vscode";
import type { FileInfo } from "../core/expr";
import { isFresh, parseCache, serializeCache, type CacheEntry } from "../core/indexCache";
import { parseRecord, sourceKind, type FileRecord } from "../core/record";
import type { IndexProgress } from "../protocol";
import { disk, type DiskStat } from "./disk";

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


const CACHE_FILE = "index-cache.json";
const BATCH = 64;

export class WorkspaceIndex implements vscode.Disposable {
  private readonly records = new Map<string, FileRecord>();
  /** What is on disk, as last read: the content of the cache. */
  private readonly disk = new Map<string, CacheEntry>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private ready: Promise<void> | undefined;
  private scanned: Promise<void> | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private lastFire = 0;
  private paths = 0;

  /** Set while a scan runs. */
  progress: IndexProgress | undefined;
  /** What the last scan did: files taken from the cache, read, and dropped. */
  lastScan: { reused: number; read: number; removed: number } | undefined;

  /** Fires, debounced, after records were added, changed or removed, and as a scan progresses. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly storage: vscode.Uri | undefined,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Starts indexing on first use; resolves as soon as there is something to show. */
  ensureReady(): Promise<void> {
    this.ready ??= this.start();
    return this.ready;
  }

  /** Resolves when the scan that checks every file against the disk is done. */
  async whenScanned(): Promise<void> {
    await this.ensureReady();
    await this.scanned;
  }

  all(): Iterable<FileRecord> {
    return this.records.values();
  }

  get(uri: vscode.Uri): FileRecord | undefined {
    return this.records.get(uri.toString());
  }

  /** Changes whenever a file is added or removed, not when one is only edited. */
  get pathsVersion(): number {
    return this.paths;
  }

  private setRecord(key: string, record: FileRecord): void {
    if (!this.records.has(key)) this.paths++;
    this.records.set(key, record);
  }

  private deleteRecord(key: string): void {
    if (this.records.delete(key)) this.paths++;
  }

  private async start(): Promise<void> {
    const cached = await this.loadCache();
    for (const [key, entry] of cached) this.setRecord(key, this.fromCache(key, entry));
    this.watch();
    // The scan runs in the background; the cached records (or none) show meanwhile.
    this.scanned = this.scan(cached).catch((e) => this.log.error(`Indexing failed: ${(e as Error).message}`));
  }

  private watch(): void {
    const include = vscode.workspace.getConfiguration("bases").get<string>("include", "**/*.{md,markdown,yml,yaml}");
    const watcher = vscode.workspace.createFileSystemWatcher(include);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.schedule(u)),
      watcher.onDidChange((u) => this.schedule(u)),
      watcher.onDidDelete((u) => {
        this.deleteRecord(u.toString());
        this.disk.delete(u.toString());
        this.saveSoon();
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.records.has(e.document.uri.toString())) this.schedule(e.document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bases.include") || e.affectsConfiguration("bases.exclude") || e.affectsConfiguration("files.exclude")) void this.reset();
      }),
    );
  }

  private async scan(cached: Map<string, CacheEntry>): Promise<void> {
    const started = performance.now();
    const include = vscode.workspace.getConfiguration("bases").get<string>("include", "**/*.{md,markdown,yml,yaml}");
    const uris = await vscode.workspace.findFiles(include, excludeGlob());
    const found = performance.now();
    const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    this.progress = { done: 0, total: uris.length, checking: cached.size > 0 };
    this.changed.fire();

    let reused = 0;
    let read = 0;
    const seen = new Set<string>();
    for (let i = 0; i < uris.length; i += BATCH) {
      await Promise.all(
        uris.slice(i, i + BATCH).map(async (uri) => {
          const key = uri.toString();
          seen.add(key);
          try {
            const stat = await disk.stat(uri);
            const entry = cached.get(key);
            if (isFresh(entry, stat) && !open.get(key)?.isDirty) {
              this.disk.set(key, entry);
              if (!this.records.has(key)) this.setRecord(key, this.fromCache(key, entry));
              reused++;
            } else {
              await this.load(uri, stat);
              read++;
            }
          } catch {
            this.deleteRecord(key);
            this.disk.delete(key);
          }
        }),
      );
      this.progress.done = Math.min(i + BATCH, uris.length);
      this.fireThrottled();
    }

    // Files that were cached but are gone now.
    let removed = 0;
    for (const key of [...this.records.keys()]) {
      if (!seen.has(key)) {
        this.deleteRecord(key);
        this.disk.delete(key);
        removed++;
      }
    }

    this.progress = undefined;
    this.lastScan = { reused, read, removed };
    this.changed.fire();
    if (read > 0 || removed > 0) this.saveSoon();
    const ms = (n: number) => `${Math.round(n)} ms`;
    this.log.info(`Indexed ${uris.length} files in ${ms(performance.now() - started)} (search ${ms(found - started)}): ${reused} from cache, ${read} read, ${removed} removed`);
  }

  private fireThrottled(): void {
    const now = Date.now();
    if (now - this.lastFire < 300) return;
    this.lastFire = now;
    this.changed.fire();
  }

  private fromCache(key: string, entry: CacheEntry): FileRecord {
    const uri = vscode.Uri.parse(key);
    return { uri: key, file: fileInfo(uri, entry), kind: entry.kind, properties: entry.properties, tags: entry.tags, readOnly: entry.readOnly };
  }

  private async reset(): Promise<void> {
    for (const d of this.disposables.splice(1)) d.dispose();
    this.records.clear();
    this.paths++;
    this.ready = undefined;
    await this.whenScanned();
  }

  private schedule(uri: vscode.Uri): void {
    this.pending.add(uri.toString());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 150);
  }

  private async flush(): Promise<void> {
    const uris = [...this.pending].map((s) => vscode.Uri.parse(s));
    this.pending.clear();
    await Promise.all(uris.map((u) => this.load(u).catch(() => this.deleteRecord(u.toString()))));
    this.saveSoon();
    this.changed.fire();
  }

  /** Reads and parses one file; an open editor's text wins over the disk. */
  private async load(uri: vscode.Uri, stat?: DiskStat): Promise<void> {
    const key = uri.toString();
    stat ??= await disk.stat(uri);
    const info = fileInfo(uri, stat);
    if (!sourceKind(info.ext)) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    const text = doc ? doc.getText() : new TextDecoder().decode(await disk.read(uri));
    const record = parseRecord(key, info, text);
    if (!record) return;
    this.setRecord(key, record);
    if (doc?.isDirty) {
      // Unsaved text is not what is on disk: the next start reads the file again.
      this.disk.delete(key);
    } else {
      this.disk.set(key, { mtime: stat.mtime, ctime: stat.ctime, size: stat.size, kind: record.kind, properties: record.properties, tags: record.tags, readOnly: record.readOnly });
    }
  }

  // --- the cache file ---------------------------------------------------------------

  private async loadCache(): Promise<Map<string, CacheEntry>> {
    if (!this.storage) return new Map();
    const started = performance.now();
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.storage, CACHE_FILE));
      const cache = parseCache(new TextDecoder().decode(bytes));
      this.log.info(`Loaded ${cache.size} cached records in ${Math.round(performance.now() - started)} ms`);
      return cache;
    } catch {
      return new Map();
    }
  }

  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveCache(), 3000);
  }

  /** Writes the cache now; called on shutdown, and a few seconds after changes. */
  async saveCache(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.storage || this.disk.size === 0) return;
    const started = performance.now();
    try {
      await vscode.workspace.fs.createDirectory(this.storage);
      const text = serializeCache(this.disk);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.storage, CACHE_FILE), new TextEncoder().encode(text));
      this.log.debug(`Saved ${this.disk.size} records (${Math.round(text.length / 1024)} KB) in ${Math.round(performance.now() - started)} ms`);
    } catch (e) {
      this.log.warn(`Could not save the index cache: ${(e as Error).message}`);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.saveTimer);
    for (const d of this.disposables) d.dispose();
  }
}
