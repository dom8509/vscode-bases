// The index cache: what parsing each file produced, keyed by URI, with the
// mtime and size it was read at. A file whose mtime and size still match is
// not read or parsed again.
//
// The cache is a snapshot of every entry plus a journal of the changes since.
// A change appends one line to the journal, so saving costs the same in a
// workspace of ten files as in one of fifty thousand. Now and then the journal
// is folded into a new snapshot. Both carry a generation: a journal counts
// only on the snapshot of its own generation, so a journal left over from
// before a new snapshot is ignored.

import type { SourceKind } from "./record";

/** Bump when parseRecord changes what it produces, so old caches are dropped. */
export const CACHE_VERSION = 2;

export interface CacheEntry {
  mtime: number;
  ctime: number;
  size: number;
  kind: SourceKind;
  properties: Record<string, unknown>;
  tags: string[];
  readOnly?: string;
}

export interface Snapshot {
  generation: number;
  entries: Map<string, CacheEntry>;
}

export function isFresh(entry: CacheEntry | undefined, stat: { mtime: number; size: number }): entry is CacheEntry {
  return entry !== undefined && entry.mtime === stat.mtime && entry.size === stat.size;
}

export function serializeCache(entries: Map<string, CacheEntry>, generation: number): string {
  return JSON.stringify({ version: CACHE_VERSION, generation, entries: Object.fromEntries(entries) });
}

/** The entries of a snapshot; empty when it is missing, broken or from another version. */
export function parseCache(text: string | undefined): Snapshot {
  const empty = { generation: 0, entries: new Map<string, CacheEntry>() };
  if (!text) return empty;
  try {
    const raw = JSON.parse(text) as { version?: unknown; generation?: unknown; entries?: Record<string, CacheEntry> };
    if (raw.version !== CACHE_VERSION || typeof raw.generation !== "number" || typeof raw.entries !== "object" || raw.entries === null) return empty;
    return { generation: raw.generation, entries: new Map(Object.entries(raw.entries)) };
  } catch {
    return empty;
  }
}

/** The first line of a journal: which snapshot it continues. */
export function journalHeader(generation: number): string {
  return JSON.stringify({ version: CACHE_VERSION, generation });
}

/**
 * Journal lines for changed entries; undefined means the entry is gone. Each
 * line starts with its line break, so a line a crash cut off ends where the
 * next one starts and takes no other line with it.
 */
export function journalLines(changes: Iterable<[string, CacheEntry | undefined]>): string {
  let text = "";
  for (const [key, entry] of changes) text += `\n${JSON.stringify(entry ? { k: key, e: entry } : { k: key, d: 1 })}`;
  return text;
}

export interface Replay {
  /** Lines of changes in the journal, applied or not. */
  lines: number;
  /** The journal belongs to the snapshot and was applied. */
  applied: boolean;
  /** Lines that could not be read, e.g. one cut off by a crash while it was written. */
  broken: number;
}

/**
 * Applies a journal to the snapshot of its generation, line by line, so the
 * last change to an entry wins. Applying a line twice changes nothing. A line
 * that cannot be read is skipped: the scan reads that file again anyway.
 */
export function applyJournal(snapshot: Snapshot, text: string | undefined): Replay {
  const lines = (text ?? "").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { lines: 0, applied: false, broken: 0 };
  let header: { version?: unknown; generation?: unknown } | undefined;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    // No header: nothing to tell which snapshot the journal belongs to.
  }
  if (header?.version !== CACHE_VERSION || header.generation !== snapshot.generation) return { lines: lines.length - 1, applied: false, broken: 0 };
  let broken = 0;
  for (const line of lines.slice(1)) {
    try {
      const change = JSON.parse(line) as { k?: unknown; e?: CacheEntry; d?: unknown };
      if (typeof change.k !== "string") throw new Error("no key");
      if (change.d) snapshot.entries.delete(change.k);
      else if (change.e && typeof change.e === "object") snapshot.entries.set(change.k, change.e);
      else throw new Error("no entry");
    } catch {
      broken++;
    }
  }
  return { lines: lines.length - 1, applied: true, broken };
}

/** True when the journal has grown enough that a new snapshot pays off. */
export function shouldCompact(journalLines: number, entries: number): boolean {
  return journalLines > Math.max(1000, entries / 10);
}
