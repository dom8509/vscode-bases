// Changes to the .base file itself, made from the UI: views, filters,
// columns, sort, limit and formulas. They go through the `yaml` Document API,
// and only the lines that change are rewritten.

import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import type { Filter, GroupBy, SortSpec } from "./base";
import { mergeLines } from "./writer";

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false } as const;

export type BaseOp =
  /** Sets (or, with undefined, removes) the filters that apply to every view. */
  | { op: "setBaseFilters"; filters: Filter | undefined }
  | { op: "setView"; index: number; key: "name"; value: string }
  /** The layout: table, cards, list or kanban. */
  | { op: "setView"; index: number; key: "type"; value: string }
  | { op: "setView"; index: number; key: "groupBy"; value: GroupBy | undefined }
  /** Display options; undefined removes the key, which means Obsidian's default. */
  | { op: "setView"; index: number; key: "rowHeight" | "image" | "imageFit"; value: string | undefined }
  | { op: "setView"; index: number; key: "cardSize" | "imageAspectRatio"; value: number | undefined }
  | { op: "setView"; index: number; key: "filters"; value: Filter | undefined }
  | { op: "setView"; index: number; key: "order"; value: string[] }
  | { op: "setView"; index: number; key: "sort"; value: SortSpec[] }
  | { op: "setView"; index: number; key: "limit"; value: number | undefined }
  | { op: "addView"; name: string }
  | { op: "duplicateView"; index: number; name: string }
  | { op: "removeView"; index: number }
  /** Moves a view to another place; the first view is the one a base opens with. */
  | { op: "moveView"; index: number; to: number }
  /** Sets a formula; with expr undefined, removes it (and its column from every view). */
  | { op: "setFormula"; name: string; expr: string | undefined }
  /** Renames a formula in place, with its columns, sorts, groups and display name in every view. */
  | { op: "renameFormula"; from: string; to: string }
  /** A property the files were renamed in: its columns, sorts, groups and display name follow, in every view. */
  | { op: "renameProperty"; from: string; to: string }
  /** A property removed from the files: its columns, sorts, groups and display name go too. */
  | { op: "removeProperty"; name: string };

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

function views(doc: Document): YAMLMap[] {
  let seq = doc.get("views");
  if (!isSeq(seq)) {
    doc.set("views", doc.createNode([{ type: "table", name: "Table", order: ["file.name"] }]));
    seq = doc.get("views");
  }
  if (!isSeq(seq)) throw new Error("views must be a list");
  return seq.items.map((v) => {
    if (!isMap(v)) throw new Error("A view must be a mapping");
    return v as YAMLMap;
  });
}

function view(doc: Document, index: number): YAMLMap {
  const v = views(doc)[index];
  if (!v) throw new Error(`No view ${index + 1}`);
  return v;
}

// The order Obsidian writes keys in; a new key goes to its place in it.
const ROOT_KEYS = ["filters", "formulas", "properties", "summaries", "views"];
const VIEW_KEYS = ["type", "name", "filters", "groupBy", "order", "sort", "limit", "rowHeight", "image", "imageAspectRatio", "imageFit", "cardSize"];

/** Sets a key, keeping a flow list a flow list; an empty value removes the key. */
function setKey(doc: Document, map: YAMLMap, key: string, value: unknown, keyOrder: string[]): void {
  if (isEmptyValue(value)) {
    map.delete(key);
    return;
  }
  const old = map.get(key, true);
  const node = doc.createNode(value);
  if (isSeq(old) && isSeq(node)) node.flow = old.flow;
  if (old !== undefined || !keyOrder.includes(key)) {
    map.set(key, node);
    return;
  }
  const rank = keyOrder.indexOf(key);
  const at = map.items.findIndex((p) => {
    const r = keyOrder.indexOf(String((p.key as { value?: unknown })?.value ?? p.key));
    return r > rank;
  });
  const pair = doc.createPair(key, node);
  if (at < 0) map.items.push(pair as never);
  else map.items.splice(at, 0, pair as never);
}

function renameKey(doc: Document, map: YAMLMap, from: string, to: string): void {
  const pair = map.items.find((p) => String((p.key as { value?: unknown })?.value ?? p.key) === from);
  if (pair) pair.key = doc.createNode(to) as never;
}

/** Points every column, sort, group and display name of `from` at `to`. */
function renameColumn(doc: Document, from: string, to: string): void {
  const properties = (doc.contents as YAMLMap).get("properties", true);
  if (isMap(properties)) renameKey(doc, properties, from, to);
  for (const v of views(doc)) {
    const order = v.get("order", true);
    if (isSeq(order)) for (const n of order.items) if (isScalar(n) && n.value === from) n.value = to;
    const sort = v.get("sort", true);
    if (isSeq(sort)) for (const s of sort.items) if (isMap(s) && s.get("property") === from) s.set("property", to);
    const groupBy = v.get("groupBy", true);
    if (isMap(groupBy) && groupBy.get("property") === from) groupBy.set("property", to);
    else if (isScalar(groupBy) && groupBy.value === from) groupBy.value = to;
  }
}

/** Removes every column, sort, group and display name of `id`. */
function removeColumn(doc: Document, id: string): void {
  const root = doc.contents as YAMLMap;
  const properties = root.get("properties", true);
  if (isMap(properties)) {
    properties.delete(id);
    if (properties.items.length === 0) root.delete("properties");
  }
  for (const v of views(doc)) {
    const order = v.get("order", true);
    if (isSeq(order)) order.items = order.items.filter((n) => (n as { value?: unknown }).value !== id);
    const sort = v.get("sort", true);
    if (isSeq(sort)) {
      sort.items = sort.items.filter((s) => !(isMap(s) && s.get("property") === id));
      if (sort.items.length === 0) v.delete("sort");
    }
    const groupBy = v.get("groupBy", true);
    if ((isMap(groupBy) && groupBy.get("property") === id) || (isScalar(groupBy) && groupBy.value === id)) v.delete("groupBy");
  }
}

function apply(doc: Document, op: BaseOp): void {
  const root = doc.contents as YAMLMap;
  switch (op.op) {
    case "setBaseFilters":
      setKey(doc, root, "filters", op.filters, ROOT_KEYS);
      return;
    case "setView":
      setKey(doc, view(doc, op.index), op.key, op.value, VIEW_KEYS);
      return;
    case "addView": {
      views(doc);
      const seq = doc.get("views");
      if (isSeq(seq)) seq.add(doc.createNode({ type: "table", name: op.name, order: ["file.name"] }));
      return;
    }
    case "duplicateView": {
      const copy = view(doc, op.index).clone() as YAMLMap;
      copy.set("name", op.name);
      const seq = doc.get("views");
      if (isSeq(seq)) seq.items.splice(op.index + 1, 0, copy);
      return;
    }
    case "removeView": {
      if (views(doc).length <= 1) throw new Error("A base keeps at least one view");
      const seq = doc.get("views");
      if (isSeq(seq)) seq.items.splice(op.index, 1);
      return;
    }
    case "moveView": {
      const moved = view(doc, op.index);
      const seq = doc.get("views");
      if (isSeq(seq)) {
        seq.items.splice(op.index, 1);
        seq.items.splice(Math.max(0, Math.min(op.to, seq.items.length)), 0, moved);
      }
      return;
    }
    case "setFormula": {
      let formulas = root.get("formulas", true);
      if (op.expr === undefined) {
        if (isMap(formulas)) {
          formulas.delete(op.name);
          if (formulas.items.length === 0) root.delete("formulas");
        }
        // A removed formula leaves no dangling column or sort behind.
        const id = `formula.${op.name}`;
        for (const v of views(doc)) {
          const order = v.get("order", true);
          if (isSeq(order)) order.items = order.items.filter((n) => (n as { value?: unknown }).value !== id);
          const sort = v.get("sort", true);
          if (isSeq(sort)) {
            sort.items = sort.items.filter((s) => !(isMap(s) && s.get("property") === id));
            if (sort.items.length === 0) v.delete("sort");
          }
        }
        return;
      }
      if (!isMap(formulas)) {
        setKey(doc, root, "formulas", { [op.name]: op.expr }, ROOT_KEYS);
        return;
      }
      if (isMap(formulas)) formulas.set(op.name, op.expr);
      return;
    }
    case "renameFormula": {
      if (op.from === op.to) return;
      const formulas = root.get("formulas", true);
      if (!isMap(formulas) || !formulas.has(op.from)) throw new Error(`No formula ${op.from}`);
      if (formulas.has(op.to)) throw new Error(`A formula ${op.to} already exists`);
      renameKey(doc, formulas, op.from, op.to);
      renameColumn(doc, `formula.${op.from}`, `formula.${op.to}`);
      return;
    }
    case "renameProperty":
      if (op.from !== op.to) renameColumn(doc, op.from, op.to);
      return;
    case "removeProperty":
      removeColumn(doc, op.name);
      return;
  }
}

/** Returns the base text with the operations applied, in order. */
export function updateBase(text: string, ops: BaseOp[]): string {
  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`YAML error: ${doc.errors[0]!.message.split("\n")[0]}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error("A base must be a YAML mapping");
  const before = doc.toString(STRINGIFY);
  for (const op of ops) apply(doc, op);
  return mergeLines(text, before, doc.toString(STRINGIFY), text.includes("\r\n") ? "\r\n" : "\n");
}

/** A new base: one table that lists every file by name. */
export const NEW_BASE = `views:
  - type: table
    name: Table
    order:
      - file.name
`;
