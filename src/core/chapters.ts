// Group hierarchies: a group value can stand for several levels of headings.
// How it splits is the view's `groupBy.separator`:
//
// - "." (the default): chapter numbers. "3.2 Anmeldung" is chapter 3.2 with
//   the title "Anmeldung", under chapter 3. Values without a number in front
//   are plain groups, one level deep.
// - any other text, e.g. "/" or ">": paths. "Funktionen/Anmeldung" is
//   "Anmeldung" under "Funktionen" — folders, nested tags, free text.
// - "": no hierarchy; every value is one group.
//
// Rows grouped this way read as an outline: a heading for each level as it
// starts, then the rows.

import type { Row } from "./base";

export const CHAPTERS = ".";

export interface Level {
  /** Unique across the outline: "3.2", or "Funktionen/Anmeldung". */
  key: string;
  /** The chapter number, in chapter mode; "" otherwise. */
  number: string;
  /** The heading's text: a chapter title, or the path segment. */
  title: string;
}

interface Parsed {
  levels: Level[];
  /** Compared level by level: numbers numerically, text by name. */
  sortKey: (number | string)[];
  /** Chapters sort before plain groups. */
  numbered: boolean;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(text).join(", ");
  return String(v);
}

const CHAPTER = /^(\d+(?:\.\d+)*)\.?(?:\s+(.*))?$/;

function parse(value: unknown, separator = CHAPTERS): Parsed {
  const s = text(value).trim();
  if (s === "") return { levels: [{ key: "", number: "", title: "" }], sortKey: [], numbered: false };
  if (separator === CHAPTERS) {
    const m = CHAPTER.exec(s);
    if (m) {
      const nums = m[1]!.split(".");
      return {
        levels: nums.map((_, i) => {
          const key = nums.slice(0, i + 1).join(".");
          return { key, number: key, title: i === nums.length - 1 ? (m[2] ?? "").trim() : "" };
        }),
        sortKey: nums.map(Number),
        numbered: true,
      };
    }
  } else if (separator !== "") {
    const segments = s.split(separator).map((x) => x.trim()).filter(Boolean);
    if (segments.length > 0) {
      return {
        levels: segments.map((title, i) => ({ key: segments.slice(0, i + 1).join(separator), number: "", title })),
        sortKey: segments,
        numbered: false,
      };
    }
  }
  return { levels: [{ key: s, number: "", title: s }], sortKey: [s], numbered: false };
}

/** The levels of a group value, outermost first. */
export function levelsOf(value: unknown, separator?: string): Level[] {
  return parse(value, separator).levels;
}

/** Reading order: 3 < 3.2 < 3.10 < 4, a parent before its children, plain groups after chapters, no value last. */
export function compareGroups(a: unknown, b: unknown, separator?: string): number {
  const x = parse(a, separator);
  const y = parse(b, separator);
  const xe = x.sortKey.length === 0;
  const ye = y.sortKey.length === 0;
  if (xe || ye) return xe === ye ? 0 : xe ? 1 : -1;
  if (x.numbered !== y.numbered) return x.numbered ? -1 : 1;
  for (let i = 0; i < Math.min(x.sortKey.length, y.sortKey.length); i++) {
    const p = x.sortKey[i]!;
    const q = y.sortKey[i]!;
    const d = typeof p === "number" && typeof q === "number" ? p - q : String(p).localeCompare(String(q), undefined, { numeric: true });
    if (d !== 0) return d;
  }
  return x.sortKey.length - y.sortKey.length;
}

export type OutlineItem =
  | { kind: "heading"; level: number; number: string; title: string }
  | { kind: "row"; row: Row };

/**
 * The rows with a heading wherever a level starts, and headings for the
 * levels above it that have not been shown yet. A chapter's title comes from
 * any value that names it (`known`: other values of the property, e.g. "3 Funktionen").
 */
export function outline(rows: Row[], groupId: string, known: unknown[] = [], separator?: string): OutlineItem[] {
  const titles = new Map<string, string>();
  for (const v of [...known, ...rows.map((r) => r.cells[groupId])]) {
    const last = levelsOf(v, separator).at(-1)!;
    if (last.number && last.title && !titles.has(last.key)) titles.set(last.key, last.title);
  }
  const items: OutlineItem[] = [];
  let shown: string[] = [];
  for (const row of rows) {
    levelsOf(row.cells[groupId], separator).forEach((l, depth) => {
      if (shown[depth] === l.key) return;
      shown = [...shown.slice(0, depth), l.key];
      const title = l.number ? titles.get(l.key) ?? "" : l.title || "No value";
      items.push({ kind: "heading", level: depth + 1, number: l.number, title });
    });
    items.push({ kind: "row", row });
  }
  return items;
}
