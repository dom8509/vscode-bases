import { describe, expect, it } from "vitest";
import { CACHE_VERSION, isFresh, parseCache, serializeCache, type CacheEntry } from "../src/core/indexCache";

const entry: CacheEntry = { mtime: 10, ctime: 5, size: 42, kind: "markdown", properties: { status: "open", tags: ["a"] }, tags: ["a"] };

describe("index cache", () => {
  it("round-trips its entries", () => {
    const text = serializeCache(new Map([["file:///ws/a.md", entry]]));
    expect(parseCache(text)).toEqual(new Map([["file:///ws/a.md", entry]]));
  });

  it("drops a cache from another version, or a broken one", () => {
    expect(parseCache(JSON.stringify({ version: CACHE_VERSION + 1, entries: { x: entry } })).size).toBe(0);
    expect(parseCache("{not json").size).toBe(0);
    expect(parseCache(undefined).size).toBe(0);
  });

  it("trusts an entry only while mtime and size match", () => {
    expect(isFresh(entry, { mtime: 10, size: 42 })).toBe(true);
    expect(isFresh(entry, { mtime: 11, size: 42 })).toBe(false);
    expect(isFresh(entry, { mtime: 10, size: 43 })).toBe(false);
    expect(isFresh(undefined, { mtime: 10, size: 42 })).toBe(false);
  });
});
