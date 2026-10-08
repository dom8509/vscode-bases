// Keeps a record of every Markdown and YAML file in the workspace, current
// with the file system and with unsaved changes in open editors.
//
// What parsing produced is cached per workspace. On start the cached records
// are shown at once; a scan then stats every file and reads only the ones
// whose mtime or size changed, and drops the ones that are gone.
//
// The cache is a snapshot and a journal (see core/indexCache): a change to a
// few files appends a few lines; only a long journal is folded into a new
// snapshot, written beside the old one and then renamed over it.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { FileInfo } from "../core/expr";
import { applyJournal, isFresh, journalHeader, journalLines, parseCache, serializeCache, shouldCompact, type CacheEntry } from "../core/indexCache";
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
const JOURNAL_FILE = "index-cache.journal";
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
  // The cache on disk: the snapshot's generation, the lines in its journal,
  // and the entries changed since the last write.
  private generation = 0;
  private journalCount = 0;
  private needsSnapshot = true;
  private readonly unsaved = new Set<string>();
  private writing: Promise<void> = Promise.resolve();

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
        this.dropDisk(u.toString());
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
            this.dropDisk(key);
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
        this.dropDisk(key);
        removed++;
      }
    }

    this.progress = undefined;
    this.lastScan = { reused, read, removed };
    this.changed.fire();
    if (this.unsaved.size > 0 || this.needsSnapshot) this.saveSoon();
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
    // What is not saved yet goes first, so the cache read next is complete.
    await this.saveCache();
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
      this.dropDisk(key);
    } else {
      this.setDisk(key, { mtime: stat.mtime, ctime: stat.ctime, size: stat.size, kind: record.kind, properties: record.properties, tags: record.tags, readOnly: record.readOnly });
    }
  }

  // --- the cache file ---------------------------------------------------------------

  /** A change to what is on disk, for the journal. */
  private setDisk(key: string, entry: CacheEntry): void {
    this.disk.set(key, entry);
    this.unsaved.add(key);
  }

  private dropDisk(key: string): void {
    if (this.disk.delete(key)) this.unsaved.add(key);
  }

  private async loadCache(): Promise<Map<string, CacheEntry>> {
    if (!this.storage) return new Map();
    const started = performance.now();
    const read = (name: string) => readFile(vscode.Uri.joinPath(this.storage!, name).fsPath, "utf8").catch(() => undefined);
    const snapshot = parseCache(await read(CACHE_FILE));
    const replay = snapshot.generation > 0 ? applyJournal(snapshot, await read(JOURNAL_FILE)) : undefined;
    this.generation = snapshot.generation;
    this.journalCount = replay?.lines ?? 0;
    // Without a snapshot, with a journal of another one, or with broken lines: write a new snapshot.
    this.needsSnapshot = snapshot.generation === 0 || (replay !== undefined && replay.lines > 0 && (!replay.applied || replay.broken > 0));
    if (snapshot.generation > 0) {
      const journal = replay?.applied ? `, ${replay.lines} changes from the journal${replay.broken ? ` (${replay.broken} unreadable)` : ""}` : "";
      this.log.info(`Loaded ${snapshot.entries.size} cached records${journal} in ${Math.round(performance.now() - started)} ms`);
    }
    return snapshot.entries;
  }

  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveCache(), 1000);
  }

  /** Writes what changed now; called on shutdown, and a second after changes. Writes run one after another. */
  saveCache(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  private async write(): Promise<void> {
    if (!this.storage) return;
    const dir = this.storage.fsPath;
    const path = (name: string) => vscode.Uri.joinPath(this.storage!, name).fsPath;
    const started = performance.now();
    const ms = () => `${Math.round(performance.now() - started)} ms`;
    try {
      if (this.needsSnapshot || shouldCompact(this.journalCount + this.unsaved.size, this.disk.size)) {
        if (this.disk.size === 0) return;
        // A new snapshot, written beside the old one and renamed over it, then an empty journal for it.
        // A crash in between leaves the old snapshot, or the new one with the old journal, which it ignores.
        const generation = this.generation + 1;
        const text = serializeCache(this.disk, generation);
        this.unsaved.clear();
        await mkdir(dir, { recursive: true });
        await writeFile(path(`${CACHE_FILE}.tmp`), text);
        await rename(path(`${CACHE_FILE}.tmp`), path(CACHE_FILE));
        await writeFile(path(JOURNAL_FILE), journalHeader(generation));
        this.generation = generation;
        this.journalCount = 0;
        this.needsSnapshot = false;
        this.log.debug(`Saved ${this.disk.size} records (${Math.round(text.length / 1024)} KB) in ${ms()}`);
      } else if (this.unsaved.size > 0) {
        const changes = [...this.unsaved].map((key): [string, CacheEntry | undefined] => [key, this.disk.get(key)]);
        this.unsaved.clear();
        await appendFile(path(JOURNAL_FILE), journalLines(changes));
        this.journalCount += changes.length;
        this.log.debug(`Saved ${changes.length} changes to the journal in ${ms()}`);
      }
    } catch (e) {
      // The next write starts over with a new snapshot.
      this.needsSnapshot = true;
      this.log.warn(`Could not save the index cache: ${(e as Error).message}`);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.saveTimer);
    for (const d of this.disposables) d.dispose();
  }
}
