// Changes to the .base file itself, made from the UI. They go through the
// `yaml` Document API so the rest of the file keeps its formatting.

import { isMap, isSeq, parseDocument, type Document } from "yaml";
import type { SortSpec } from "./base";
import { mergeLines } from "./writer";

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Returns the base text with the sort of one view replaced; an empty sort removes the key. */
export function setViewSort(text: string, viewIndex: number, sort: SortSpec[]): string {
  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`YAML error: ${doc.errors[0]!.message.split("\n")[0]}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error("A base must be a YAML mapping");
  const before = doc.toString(STRINGIFY);

  let views = doc.get("views");
  if (!isSeq(views) || views.items.length === 0) {
    doc.set("views", doc.createNode([{ type: "table", name: "Table" }]));
    views = doc.get("views");
  }
  if (!isSeq(views)) throw new Error("views must be a list");
  const view = views.items[Math.min(viewIndex, views.items.length - 1)];
  if (!isMap(view)) throw new Error("A view must be a mapping");

  if (sort.length === 0) view.delete("sort");
  else view.set("sort", doc.createNode(sort));
  return mergeLines(text, before, doc.toString(STRINGIFY), text.includes("\r\n") ? "\r\n" : "\n");
}

export const NEW_BASE = `# A base: a live table of the Markdown and YAML files in this workspace.
# Expressions follow the Obsidian Bases syntax, e.g. file.ext == "md",
# file.inFolder("docs"), file.hasTag("project"), status != "done".
filters:
  and:
    - file.ext == "md"
views:
  - type: table
    name: All notes
`;
