// Links between files, as a project's own database stores them. A query
// returns one row per link: source, target and, optionally, its type. The
// paths in the rows are matched to the files of the workspace here.

import type { Database, SqlJsStatic } from "sql.js";

export interface LinkRow {
  source: string;
  target: string;
  type: string;
}

/** Runs the query on a database (the bytes of an SQLite file) and returns its links. */
export function readLinks(SQL: SqlJsStatic, bytes: Uint8Array, query: string): LinkRow[] {
  let db: Database | undefined;
  try {
    db = new SQL.Database(bytes);
    const rows: LinkRow[] = [];
    const stmt = db.prepare(query);
    try {
      const cols = stmt.getColumnNames().map((c) => c.toLowerCase());
      // Columns by name; without those names the first, second and third.
      const at = (name: string, fallback: number) => (cols.includes(name) ? cols.indexOf(name) : cols.length > fallback ? fallback : -1);
      const s = at("source", 0);
      const t = at("target", 1);
      const k = at("type", cols.length > 2 ? 2 : -1);
      if (s < 0 || t < 0) throw new Error("The query must return two columns: source and target (and type, if links have types)");
      while (stmt.step()) {
        const row = stmt.get();
        const source = row[s];
        const target = row[t];
        if (source === null || source === undefined || target === null || target === undefined) continue;
        rows.push({ source: String(source), target: String(target), type: k >= 0 && row[k] !== null && row[k] !== undefined ? String(row[k]) : "" });
      }
    } finally {
      stmt.free();
    }
    return rows;
  } finally {
    db?.close();
  }
}

/** Removes `.` and `..` from a path with forward slashes. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Finds the workspace file a link names. Tried in this order: the path from
 * the workspace folder, from the database's folder, the same with `.md`, then
 * a file of that name anywhere (when only one has it). A value no file
 * matches stays as it is.
 */
export function makeResolver(paths: Iterable<string>, dbFolder: string, toRelative: (absolute: string) => string | undefined): (raw: string) => string {
  const known = new Set<string>();
  const byName = new Map<string, string | null>();
  const addName = (name: string, path: string) => byName.set(name, byName.has(name) && byName.get(name) !== path ? null : path);
  for (const p of paths) {
    known.add(p);
    const name = p.split("/").pop()!.toLowerCase();
    addName(name, p);
    const dot = name.lastIndexOf(".");
    if (dot > 0) addName(name.slice(0, dot), p);
  }
  const memo = new Map<string, string>();
  return (raw) => {
    // Most databases store the path as the workspace has it.
    if (known.has(raw)) return raw;
    let hit = memo.get(raw);
    if (hit !== undefined) return hit;
    // [[Note|alias]] and [[Note#heading]] name the note.
    let v = raw.trim().replace(/^!?\[\[(.*)\]\]$/, "$1").replace(/[|#].*$/, "").replace(/\\/g, "/").trim();
    if (/^(?:\/|[A-Za-z]:\/)/.test(v)) v = toRelative(v) ?? v;
    const candidates = [normalize(v), normalize(`${dbFolder}/${v}`)];
    hit = [...candidates, ...candidates.map((c) => `${c}.md`)].find((c) => known.has(c));
    hit ??= byName.get(v.split("/").pop()!.toLowerCase()) ?? normalize(v);
    memo.set(raw, hit);
    return hit;
  };
}

/** The links of every file, both ways, with the paths resolved. */
export class LinkGraph {
  private readonly out = new Map<string, LinkRow[]>();
  private readonly in = new Map<string, LinkRow[]>();
  /** Link types, A to Z; "" (no type) is left out. */
  readonly types: string[];

  constructor(rows: LinkRow[], readonly resolve: (raw: string) => string = (s) => s, readonly error?: string) {
    const types = new Set<string>();
    for (const r of rows) {
      const link = { source: resolve(r.source), target: resolve(r.target), type: r.type };
      push(this.out, link.source, link);
      push(this.in, link.target, link);
      if (r.type) types.add(r.type);
    }
    this.types = [...types].sort((a, b) => a.localeCompare(b));
  }

  /** The files `path` links to; only links of these types, when there are any. */
  linksOf(path: string, types: string[] = []): string[] {
    return pick(this.out.get(path), types, (l) => l.target);
  }

  /** The files that link to `path`. */
  backlinksOf(path: string, types: string[] = []): string[] {
    return pick(this.in.get(path), types, (l) => l.source);
  }
}

function push(map: Map<string, LinkRow[]>, key: string, link: LinkRow): void {
  const list = map.get(key);
  if (list) list.push(link);
  else map.set(key, [link]);
}

function pick(links: LinkRow[] | undefined, types: string[], end: (l: LinkRow) => string): string[] {
  if (!links) return [];
  const seen = new Set<string>();
  for (const l of links) if (types.length === 0 || types.includes(l.type)) seen.add(end(l));
  return [...seen];
}
