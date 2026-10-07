// Applies property edits to the text of a file. Only the YAML region is
// rewritten, through the `yaml` Document API, so comments, key order and
// scalar styles survive.

import { isMap, isScalar, isSeq, parse, parseAllDocuments, parseDocument, type Document, type ToStringOptions } from "yaml";
import { sourceKind, yamlRegion } from "./record";

export type PropertyEdit =
  | { kind: "set"; key: string; value: unknown }
  | { kind: "delete"; key: string }
  | { kind: "rename"; from: string; to: string };

export interface TextChange {
  start: number;
  end: number;
  text: string;
}

const STRINGIFY: ToStringOptions = { lineWidth: 0, flowCollectionPadding: false };

/** Reads what a person typed into a cell as a YAML value: `3` is a number, `[a, b]` a list. */
export function parseInputValue(input: string): unknown {
  if (input.trim() === "") return null;
  try {
    return parse(input);
  } catch {
    return input;
  }
}

function applyOne(doc: Document, edit: PropertyEdit): void {
  if (doc.contents === null) doc.contents = doc.createNode({});
  const map = doc.contents;
  if (!isMap(map)) throw new Error("Top level is not a mapping");

  switch (edit.kind) {
    case "set": {
      const existing = map.get(edit.key, true);
      const isPlainValue = edit.value === null || ["string", "number", "boolean"].includes(typeof edit.value);
      if (isScalar(existing) && isPlainValue) {
        // Keep the scalar node, and with it its quoting and comments.
        existing.value = edit.value;
      } else {
        const node = doc.createNode(edit.value);
        if (isSeq(existing) && isSeq(node)) node.flow = existing.flow;
        map.set(edit.key, node);
      }
      return;
    }
    case "delete":
      map.delete(edit.key);
      return;
    case "rename": {
      if (edit.from === edit.to || !map.has(edit.from)) return;
      if (map.has(edit.to)) throw new Error(`Property "${edit.to}" already exists`);
      const pair = map.items.find((p) => isScalar(p.key) && p.key.value === edit.from);
      if (pair && isScalar(pair.key)) pair.key.value = edit.to;
      return;
    }
  }
}

/**
 * Returns the single text change that applies the edits, or undefined when the
 * file stays as it is. Throws when the file cannot be edited.
 */
export function applyEdits(text: string, ext: string, edits: PropertyEdit[]): TextChange | undefined {
  const kind = sourceKind(ext);
  if (!kind) throw new Error(`Unsupported file type: .${ext}`);
  const region = yamlRegion(text, kind);
  const yamlText = text.slice(region.start, region.end);

  let doc: Document;
  if (kind === "yaml") {
    const docs = parseAllDocuments(yamlText);
    if (!Array.isArray(docs) || docs.length > 1) throw new Error("Multi-document YAML is read-only");
    doc = docs[0] ?? parseDocument("");
  } else {
    doc = parseDocument(yamlText);
  }
  if (doc.errors.length > 0) throw new Error(`YAML error: ${doc.errors[0]!.message.split("\n")[0]}`);

  const before = doc.toString(STRINGIFY);
  for (const edit of edits) applyOne(doc, edit);
  const after = doc.toString(STRINGIFY);
  if (after === before) return undefined;

  const { eol } = region;
  if (!region.exists) {
    // A Markdown file without frontmatter gets one.
    return { start: region.start, end: region.start, text: `---${eol}${after.replace(/\r?\n/g, eol)}---${eol}` };
  }
  const merged = mergeLines(yamlText, before, after, eol);
  return narrow(yamlText, merged, region.start);
}

/**
 * Stringifying normalises lines nobody touched (spacing before comments,
 * quoting). Takes the lines that changed between `before` and `after` and
 * applies only those to the original text, so every other line stays as it
 * was. Falls back to `after` when the original and `before` do not line up.
 */
export function mergeLines(original: string, before: string, after: string, eol: string): string {
  const o = original.split(/\r?\n/);
  const b = before.split("\n");
  const a = after.split("\n");
  if (o.length !== b.length) return after.replace(/\n/g, eol);

  let head = 0;
  while (head < b.length && head < a.length && b[head] === a[head]) head++;
  let tail = 0;
  while (tail < b.length - head && tail < a.length - head && b[b.length - 1 - tail] === a[a.length - 1 - tail]) tail++;

  const bMid = b.slice(head, b.length - tail);
  const aMid = a.slice(head, a.length - tail);
  const out = [...o.slice(0, head), ...diffMerge(o.slice(head, o.length - tail), bMid, aMid), ...o.slice(o.length - tail)];
  return out.join(eol);
}

/** Lines of `b` kept in `a` come from `o` (same positions as `b`); the rest come from `a`. */
function diffMerge(o: string[], b: string[], a: string[]): string[] {
  if (b.length * a.length > 1_000_000) return a;
  // Longest common subsequence table, from the end.
  const lcs: number[][] = Array.from({ length: b.length + 1 }, () => new Array<number>(a.length + 1).fill(0));
  for (let i = b.length - 1; i >= 0; i--)
    for (let j = a.length - 1; j >= 0; j--)
      lcs[i]![j] = b[i] === a[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) {
      out.push(o[i]!);
      i++;
      j++;
    } else if (j < a.length && (i >= b.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(a[j]!);
      j++;
    } else {
      i++;
    }
  }
  return out;
}

/** Shrinks a replacement of `original` by `next` to the span that differs. */
function narrow(original: string, next: string, offset: number): TextChange | undefined {
  if (original === next) return undefined;
  let head = 0;
  while (head < original.length && head < next.length && original[head] === next[head]) head++;
  let tail = 0;
  while (tail < original.length - head && tail < next.length - head && original[original.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return { start: offset + head, end: offset + original.length - tail, text: next.slice(head, next.length - tail) };
}
