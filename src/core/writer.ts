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
  return textChange(yamlText, merged, region.start);
}

/**
 * Stringifying normalises lines nobody touched: spacing before comments,
 * quoting, blank lines. Takes what changed between `before` and `after` (both
 * normalised) and applies only that to the original, so every other line
 * stays exactly as it was. Original lines are matched to normalised ones by a
 * diff, so a normalisation that adds or drops lines does not misalign them.
 */
export function mergeLines(original: string, before: string, after: string, eol: string): string {
  const o = original.split(/\r?\n/);
  const b = before.split("\n");
  const a = after.split("\n");

  // b line -> the identical original line, where there is one.
  const bToO = new Array<number>(b.length).fill(-1);
  for (const [i, j] of matchLines(o, b)) bToO[j] = i;

  // b lines that survive into a, and the a lines that are new after each b line.
  const kept = new Array<boolean>(b.length).fill(false);
  const inserts = new Map<number, string[]>();
  let prevB = -1;
  let prevA = -1;
  for (const [i, j] of [...matchLines(b, a), [b.length, a.length] as [number, number]]) {
    if (j > prevA + 1) inserts.set(prevB, a.slice(prevA + 1, j));
    if (i < b.length) kept[i] = true;
    prevB = i;
    prevA = j;
  }

  const out: string[] = [...(inserts.get(-1) ?? [])];
  const emitNormalised = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (kept[i]) out.push(b[i]!);
      out.push(...(inserts.get(i) ?? []));
    }
  };

  let oPos = 0;
  let bPos = 0;
  const anchors: [number, number][] = [];
  for (let j = 0; j < b.length; j++) if (bToO[j]! >= 0) anchors.push([bToO[j]!, j]);
  anchors.push([o.length, b.length]);

  for (const [ok, bk] of anchors) {
    // The stretch between two anchors: original lines with no identical normalised line.
    let untouched = true;
    for (let i = bPos; i < bk; i++) if (!kept[i] || (i < bk - 1 && inserts.has(i))) untouched = false;
    if (untouched) {
      out.push(...o.slice(oPos, ok));
      if (bk > bPos) out.push(...(inserts.get(bk - 1) ?? []));
    } else {
      emitNormalised(bPos, bk);
    }
    if (bk < b.length) {
      if (kept[bk]) out.push(o[ok]!);
      out.push(...(inserts.get(bk) ?? []));
    }
    oPos = ok + 1;
    bPos = bk + 1;
  }
  return out.join(eol);
}

/** Pairs of indexes of equal lines in x and y, in order: a longest common subsequence. */
function matchLines(x: string[], y: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) pairs.push([head, head++]);
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;

  const xm = x.slice(head, x.length - tail);
  const ym = y.slice(head, y.length - tail);
  // Very large middles are not worth the quadratic table: they get rewritten.
  if (xm.length * ym.length <= 4_000_000) {
    const lcs: Uint32Array[] = Array.from({ length: xm.length + 1 }, () => new Uint32Array(ym.length + 1));
    for (let i = xm.length - 1; i >= 0; i--)
      for (let j = ym.length - 1; j >= 0; j--)
        lcs[i]![j] = xm[i] === ym[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < xm.length && j < ym.length) {
      if (xm[i] === ym[j]) {
        pairs.push([head + i, head + j]);
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }
  for (let t = tail; t > 0; t--) pairs.push([x.length - t, y.length - t]);
  return pairs;
}

/** The smallest change that turns `original` into `next`; offsets shifted by `offset`. */
export function textChange(original: string, next: string, offset = 0): TextChange | undefined {
  if (original === next) return undefined;
  let head = 0;
  while (head < original.length && head < next.length && original[head] === next[head]) head++;
  let tail = 0;
  while (tail < original.length - head && tail < next.length - head && original[original.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return { start: offset + head, end: offset + original.length - tail, text: next.slice(head, next.length - tail) };
}
