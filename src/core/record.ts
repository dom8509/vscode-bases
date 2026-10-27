// Turns the text of a Markdown or YAML file into a record: the file's
// properties and where in the text they live, so a writer can change them.

import { isMap, parseAllDocuments, parseDocument, type Document } from "yaml";
import type { FileInfo } from "./expr";

export type SourceKind = "markdown" | "yaml";

export interface FileRecord {
  uri: string;
  file: FileInfo;
  kind: SourceKind;
  properties: Record<string, unknown>;
  tags: string[];
  /** Why the record cannot be edited; undefined when it can. */
  readOnly?: string;
  /** What the links in the body of a Markdown file name, as written: `[[Note]]` gives "Note". */
  links?: string[];
}

export function sourceKind(ext: string): SourceKind | undefined {
  switch (ext.toLowerCase()) {
    case "md": case "markdown": return "markdown";
    case "yml": case "yaml": return "yaml";
    default: return undefined;
  }
}

/** The YAML region of a file: offsets into the full text. */
export interface YamlRegion {
  /** Start of the YAML text. */
  start: number;
  /** End of the YAML text (exclusive). */
  end: number;
  /** False when a Markdown file has no frontmatter yet. */
  exists: boolean;
  eol: string;
}

/** Locates the frontmatter of a Markdown file, or the whole of a YAML file. */
export function yamlRegion(text: string, kind: SourceKind): YamlRegion {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (kind === "yaml") return { start: 0, end: text.length, exists: true, eol };
  const bom = text.startsWith("﻿") ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(text.slice(bom));
  if (!open) return { start: bom, end: bom, exists: false, eol };
  const start = bom + open[0].length;
  // An empty frontmatter closes right away.
  const close = /^(?:---|\.\.\.)[ \t]*$/m;
  const rest = text.slice(start);
  const m = close.exec(rest);
  if (!m) return { start: bom, end: bom, exists: false, eol };
  return { start, end: start + m.index, exists: true, eol };
}

/** The text of a Markdown file after its frontmatter; a YAML file has none. */
export function bodyText(text: string, kind: SourceKind): string {
  if (kind === "yaml") return "";
  const region = yamlRegion(text, kind);
  if (!region.exists) return text.replace(/^\uFEFF/, "");
  const rest = text.slice(region.end);
  return rest.replace(/^(?:---|\.\.\.)[ \t]*\r?\n?/, "").replace(/^\s*\n/, "");
}

/**
 * The links in the text of a note: `[[Note]]`, `![[Note]]`, `[[Note|alias]]`
 * and `[text](path/note.md)`, each target once, in the order they first come.
 * Code blocks and inline code are skipped, and so are web and mail links.
 * `[[Note#heading]]` names the note; a link to a heading of the note itself
 * is no link.
 */
export function bodyLinks(body: string): string[] {
  const text = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, "").replace(/`[^`\n]*`/g, "");
  const found = new Set<string>();
  const add = (raw: string) => {
    const target = raw.replace(/[|#].*$/, "").trim();
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) found.add(target);
  };
  for (const m of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) add(m[1]!);
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    let target = m[1]!;
    try {
      target = decodeURIComponent(target);
    } catch {
      // Not encoded: keep it as written.
    }
    add(target);
  }
  return [...found];
}

function tagsOf(properties: Record<string, unknown>): string[] {
  const raw = properties.tags ?? properties.tag;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  return list
    .filter((t) => t !== null && t !== undefined && String(t).trim() !== "")
    .map((t) => String(t).trim().replace(/^#/, "").toLowerCase());
}

export function parseRecord(uri: string, file: FileInfo, text: string): FileRecord | undefined {
  const kind = sourceKind(file.ext);
  if (!kind) return undefined;
  const base: FileRecord = { uri, file, kind, properties: {}, tags: [] };
  if (kind === "markdown") {
    const links = bodyLinks(bodyText(text, kind));
    if (links.length) base.links = links;
  }
  const region = yamlRegion(text, kind);
  if (!region.exists) return base;
  const yamlText = text.slice(region.start, region.end);

  let doc: Document;
  if (kind === "yaml") {
    const docs = parseAllDocuments(yamlText);
    if (!Array.isArray(docs)) return { ...base, readOnly: "Not YAML" };
    if (docs.length > 1) base.readOnly = "Multi-document YAML is read-only";
    if (docs.length === 0) return base;
    doc = docs[0]!;
  } else {
    doc = parseDocument(yamlText);
  }
  if (doc.errors.length > 0) return { ...base, readOnly: `YAML error: ${doc.errors[0]!.message.split("\n")[0]}` };
  if (doc.contents === null) return base;
  if (!isMap(doc.contents)) return { ...base, readOnly: "Top level is not a mapping" };

  const properties = doc.toJS() as Record<string, unknown>;
  return { ...base, properties, tags: tagsOf(properties) };
}
