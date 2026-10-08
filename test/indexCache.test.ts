import { describe, expect, it } from "vitest";
import { applyJournal, CACHE_VERSION, isFresh, journalHeader, journalLines, parseCache, serializeCache, shouldCompact, type CacheEntry } from "../src/core/indexCache";

const entry: CacheEntry = { mtime: 10, ctime: 5, size: 42, kind: "markdown", properties: { status: "open", tags: ["a"] }, tags: ["a"] };
const changed: CacheEntry = { ...entry, mtime: 11, properties: { status: "done" } };

describe("index cache", () => {
  it("round-trips its entries and generation", () => {
    const text = serializeCache(new Map([["file:///ws/a.md", entry]]), 3);
    expect(parseCache(text)).toEqual({ generation: 3, entries: new Map([["file:///ws/a.md", entry]]) });
  });

  it("drops a cache from another version, or a broken one", () => {
    expect(parseCache(JSON.stringify({ version: CACHE_VERSION + 1, generation: 1, entries: { x: entry } })).entries.size).toBe(0);
    expect(parseCache(JSON.stringify({ version: 1, entries: { x: entry } })).generation).toBe(0);
    expect(parseCache("{not json").entries.size).toBe(0);
    expect(parseCache(undefined).generation).toBe(0);
  });

  it("trusts an entry only while mtime and size match", () => {
    expect(isFresh(entry, { mtime: 10, size: 42 })).toBe(true);
    expect(isFresh(entry, { mtime: 11, size: 42 })).toBe(false);
    expect(isFresh(entry, { mtime: 10, size: 43 })).toBe(false);
    expect(isFresh(undefined, { mtime: 10, size: 42 })).toBe(false);
  });
});

describe("the journal", () => {
  const snapshot = () => parseCache(serializeCache(new Map([["a", entry], ["b", entry]]), 2));

  it("applies changes in order: the last one wins, a deletion removes", () => {
    const s = snapshot();
    const text = journalHeader(2) + journalLines([["a", changed], ["c", entry]]) + journalLines([["b", undefined], ["c", changed]]);
    expect(applyJournal(s, text)).toEqual({ lines: 4, applied: true, broken: 0 });
    expect(s.entries).toEqual(new Map([["a", changed], ["c", changed]]));
  });

  it("gives the same result when applied twice", () => {
    const text = journalHeader(2) + journalLines([["a", changed], ["b", undefined]]);
    const once = snapshot();
    applyJournal(once, text);
    const twice = snapshot();
    applyJournal(twice, text);
    applyJournal(twice, text);
    expect(twice.entries).toEqual(once.entries);
  });

  it("is ignored on a snapshot of another generation", () => {
    const s = snapshot();
    expect(applyJournal(s, journalHeader(1) + journalLines([["a", undefined]]))).toEqual({ lines: 1, applied: false, broken: 0 });
    expect(s.entries.has("a")).toBe(true);
    expect(applyJournal(s, journalLines([["a", undefined]])).applied).toBe(false);
  });

  it("skips a line a crash cut off, and keeps the lines after it", () => {
    const s = snapshot();
    const cut = journalLines([["a", changed]]).slice(0, 20);
    const text = journalHeader(2) + cut + journalLines([["b", undefined]]) + journalLines([["c", entry]]);
    expect(applyJournal(s, text)).toEqual({ lines: 3, applied: true, broken: 1 });
    expect(s.entries).toEqual(new Map([["a", entry], ["c", entry]]));
  });

  it("is empty when there is none", () => {
    expect(applyJournal(snapshot(), undefined)).toEqual({ lines: 0, applied: false, broken: 0 });
    expect(applyJournal(snapshot(), journalHeader(2))).toEqual({ lines: 0, applied: true, broken: 0 });
  });

  it("is folded into a snapshot once it is longer than a tenth of the entries, and at least 1,000 lines", () => {
    expect(shouldCompact(999, 100)).toBe(false);
    expect(shouldCompact(1001, 100)).toBe(true);
    expect(shouldCompact(4999, 50000)).toBe(false);
    expect(shouldCompact(5001, 50000)).toBe(true);
  });
});
