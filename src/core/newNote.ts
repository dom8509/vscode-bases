// What a note made with "New" in a view starts with: the values the view's
// filters ask for, where they say so plainly, so the new note shows in it.

import { stringify } from "yaml";
import type { BaseConfig } from "./base";
import { toModel, type FilterGroup } from "./filterModel";

export interface NewNote {
  properties: Record<string, unknown>;
  /** A folder the filters require (`file.inFolder`), if any. */
  folder?: string;
}

function typed(value: string): unknown {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return value;
}

/** Only conditions every file must meet count: those in "all of" groups, not under "any" or "none". */
function collect(group: FilterGroup, into: NewNote): void {
  if (group.conj !== "and") return;
  for (const node of group.children) {
    if (node.kind === "group") collect(node, into);
    if (node.kind !== "cond" || !node.value.trim()) continue;
    if (node.op === "inFolder") into.folder = node.value.trim().replace(/^\/+|\/+$/g, "");
    else if (node.op === "hasTag") {
      const tags = (into.properties.tags as string[] | undefined) ?? [];
      into.properties.tags = [...tags, node.value.trim().replace(/^#/, "")];
    } else if (node.op === "is" && !/^(file|formula)\./.test(node.property)) {
      into.properties[node.property.replace(/^note\./, "")] = typed(node.value);
    }
  }
}

export function newNote(base: BaseConfig, viewIndex: number): NewNote {
  const note: NewNote = { properties: {} };
  collect(toModel(base.filters), note);
  collect(toModel(base.views[viewIndex]?.filters), note);
  return note;
}

/** The text of the new file: frontmatter when there is something to put in it. */
export function noteText(properties: Record<string, unknown>): string {
  return Object.keys(properties).length > 0 ? `---\n${stringify(properties, { flowCollectionPadding: false })}---\n\n` : "";
}
