// Chapters: a group value like "3.2 Anmeldung" is chapter 3.2 with the
// title "Anmeldung", under chapter 3. Rows grouped by such values read as an
// outline: a heading for each chapter as it starts, then its rows. Values
// that are no chapter number are plain groups, one level deep.

import type { Row } from "./base";

export interface Chapter {
  /** "3.2", or the whole value when it is no chapter number. */
  key: string;
  /** [3, 2]; undefined for a plain group. */
  path?: number[];
  title: string;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(text).join(", ");
  return String(v);
}

export function chapterOf(value: unknown): Chapter {
  const s = text(value).trim();
  const m = /^(\d+(?:\.\d+)*)\.?(?:\s+(.*))?$/.exec(s);
  if (!m) return { key: s, title: s };
  return { key: m[1]!, path: m[1]!.split(".").map(Number), title: (m[2] ?? "").trim() };
}

/** Chapters in reading order: 3 < 3.2 < 3.10 < 4; plain groups after them, by name; no value last. */
export function compareChapters(a: unknown, b: unknown): number {
  const x = chapterOf(a);
  const y = chapterOf(b);
  if ((x.key === "") !== (y.key === "")) return x.key === "" ? 1 : -1;
  if (x.path && y.path) {
    for (let i = 0; i < Math.max(x.path.length, y.path.length); i++) {
      const d = (x.path[i] ?? -1) - (y.path[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  }
  if (x.path || y.path) return x.path ? -1 : 1;
  return x.key.localeCompare(y.key, undefined, { numeric: true });
}

export type OutlineItem =
  | { kind: "heading"; level: number; number: string; title: string }
  | { kind: "row"; row: Row };

/**
 * The rows with a heading wherever a chapter starts, and headings for the
 * chapters above it that have not been shown yet. Titles come from any value
 * that names the chapter (`known`: other values of the property, e.g. "3 Funktionen").
 */
export function outline(rows: Row[], groupId: string, known: unknown[] = []): OutlineItem[] {
  const titles = new Map<string, string>();
  for (const v of [...known, ...rows.map((r) => r.cells[groupId])]) {
    const c = chapterOf(v);
    if (c.path && c.title && !titles.has(c.key)) titles.set(c.key, c.title);
  }
  const items: OutlineItem[] = [];
  let shown: string[] = [];
  for (const row of rows) {
    const c = chapterOf(row.cells[groupId]);
    const chain = c.path ? c.path.map((_, i) => c.path!.slice(0, i + 1).join(".")) : [c.key];
    chain.forEach((key, level) => {
      if (shown[level] === key) return;
      shown = [...shown.slice(0, level), key];
      const title = c.path ? titles.get(key) ?? "" : key || "No value";
      items.push({ kind: "heading", level: level + 1, number: c.path ? key : "", title });
    });
    items.push({ kind: "row", row });
  }
  return items;
}
