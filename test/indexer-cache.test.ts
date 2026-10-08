import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEntry } from "../src/core/indexCache";

// Just enough of VS Code for the cache: the index's file handling runs on Node.
vi.mock("vscode", () => {
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
  const joinPath = (u: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(u.fsPath, ...parts) });
  return { EventEmitter, Uri: { joinPath } };
});

const { WorkspaceIndex } = await import("../src/host/indexer");

const log = { info() {}, debug() {}, warn() {}, error() {} };
const entry = (n: number): CacheEntry => ({ mtime: n, ctime: 1, size: 10, kind: "markdown", properties: { n }, tags: [] });
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An index whose cache lives in `dir`, with the private cache methods reachable. */
function index() {
  return new WorkspaceIndex({ fsPath: dir } as any, log as any) as any;
}
const journal = () => readFileSync(join(dir, "index-cache.journal"), "utf8").split("\n").filter(Boolean);

describe("saving the index cache", () => {
  it("writes a snapshot first, then appends only what changed, and reads both back", async () => {
    dir = mkdtempSync(join(tmpdir(), "bases-cache-"));
    const a = index();
    await a.loadCache();
    for (let i = 0; i < 50; i++) a.setDisk(`file:///ws/n${i}.md`, entry(i));
    await a.saveCache();
    const snapshot = readFileSync(join(dir, "index-cache.json"), "utf8");
    expect(journal()).toHaveLength(1);

    a.setDisk("file:///ws/n1.md", entry(100));
    a.dropDisk("file:///ws/n2.md");
    await a.saveCache();
    expect(readFileSync(join(dir, "index-cache.json"), "utf8")).toBe(snapshot);
    expect(journal()).toHaveLength(3);

    const b = index();
    const loaded: Map<string, CacheEntry> = await b.loadCache();
    expect(loaded.size).toBe(49);
    expect(loaded.get("file:///ws/n1.md")).toEqual(entry(100));
    expect(loaded.has("file:///ws/n2.md")).toBe(false);
    expect(b.needsSnapshot).toBe(false);
  });

  it("folds a long journal into a new snapshot", async () => {
    dir = mkdtempSync(join(tmpdir(), "bases-cache-"));
    const a = index();
    await a.loadCache();
    a.setDisk("file:///ws/a.md", entry(0));
    await a.saveCache();
    for (let i = 0; i < 1001; i++) a.setDisk(`file:///ws/n${i}.md`, entry(i));
    await a.saveCache();
    expect(journal()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "index-cache.json"), "utf8")).generation).toBe(2);
    expect((await index().loadCache()).size).toBe(1002);
  });

  it("ignores a journal left from before the snapshot, and then writes a new snapshot", async () => {
    dir = mkdtempSync(join(tmpdir(), "bases-cache-"));
    const a = index();
    await a.loadCache();
    a.setDisk("file:///ws/a.md", entry(1));
    await a.saveCache();
    a.setDisk("file:///ws/a.md", entry(2));
    await a.saveCache();
    // As if a crash came after the new snapshot and before its empty journal.
    const old = readFileSync(join(dir, "index-cache.journal"), "utf8");
    a.needsSnapshot = true;
    a.setDisk("file:///ws/a.md", entry(3));
    await a.saveCache();
    writeFileSync(join(dir, "index-cache.journal"), old);

    const b = index();
    expect((await b.loadCache()).get("file:///ws/a.md")).toEqual(entry(3));
    expect(b.needsSnapshot).toBe(true);
  });

  it("starts empty from a cache it cannot read, and writes a snapshot", async () => {
    dir = mkdtempSync(join(tmpdir(), "bases-cache-"));
    writeFileSync(join(dir, "index-cache.json"), "{broken");
    const b = index();
    expect((await b.loadCache()).size).toBe(0);
    expect(b.needsSnapshot).toBe(true);
  });
});
