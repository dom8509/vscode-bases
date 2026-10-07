// The index cache: what parsing each file produced, keyed by URI, with the
// mtime and size it was read at. A file whose mtime and size still match is
// not read or parsed again.

import type { SourceKind } from "./record";

/** Bump when parseRecord changes what it produces, so old caches are dropped. */
export const CACHE_VERSION = 1;

export interface CacheEntry {
  mtime: number;
  ctime: number;
  size: number;
  kind: SourceKind;
  properties: Record<string, unknown>;
  tags: string[];
  readOnly?: string;
}

export function isFresh(entry: CacheEntry | undefined, stat: { mtime: number; size: number }): entry is CacheEntry {
  return entry !== undefined && entry.mtime === stat.mtime && entry.size === stat.size;
}

export function serializeCache(entries: Map<string, CacheEntry>): string {
  return JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) });
}

/** The entries of a cache file; empty when it is missing, broken or from another version. */
export function parseCache(text: string | undefined): Map<string, CacheEntry> {
  if (!text) return new Map();
  try {
    const raw = JSON.parse(text) as { version?: unknown; entries?: Record<string, CacheEntry> };
    if (raw.version !== CACHE_VERSION || typeof raw.entries !== "object" || raw.entries === null) return new Map();
    return new Map(Object.entries(raw.entries));
  } catch {
    return new Map();
  }
}
