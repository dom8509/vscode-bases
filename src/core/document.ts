// A view as one document: chapter headings from the group, then each file
// with its title, its properties in one line and its text. Shared by the
// document layout in the webview and the Markdown/HTML export.

import type { Column, Row } from "./base";
import { outline } from "./chapters";

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(text).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const LOOKS_LIKE_ID = /^[A-Za-z][\w.-]*\d+$/;

/**
 * A file's title is its first column; when that is an ID like REQ-042 and the
 * next column is text, both: "REQ-042 Login mit SSO". The other columns,
 * without the group, are its properties.
 */
export function entryParts(columns: Column[], row: Row, groupId?: string): { title: string; fields: Column[] } {
  const shown = columns.filter((c) => c.id !== groupId);
  const [first, second] = shown;
  const name = row.path.split("/").pop()!;
  if (!first) return { title: name, fields: [] };
  const head = text(row.cells[first.id]);
  const joins = second && second.type === "text" && LOOKS_LIKE_ID.test(head) && text(row.cells[second.id]) !== "";
  return {
    title: (joins ? `${head} ${text(row.cells[second.id])}` : head) || name,
    fields: shown.slice(joins ? 2 : 1).filter((c) => text(row.cells[c.id]) !== ""),
  };
}

/** Markdown of the whole view; `known` are other values of the group, for chapter titles. */
export function documentMarkdown(name: string, columns: Column[], rows: Row[], group?: Column, separator?: string): string {
  const out = [`# ${name}`, ""];
  const items = group ? outline(rows, group.id, group.suggestions, separator) : rows.map((row) => ({ kind: "row" as const, row }));
  let depth = 1;
  for (const item of items) {
    if (item.kind === "heading") {
      depth = Math.min(item.level + 1, 5);
      out.push(`${"#".repeat(depth)} ${[item.number, item.title].filter(Boolean).join(" ")}`, "");
      continue;
    }
    const { title, fields } = entryParts(columns, item.row, group?.id);
    out.push(`${"#".repeat(Math.min(depth + 1, 6))} ${title}`, "");
    if (fields.length > 0) out.push(fields.map((c) => `**${c.label}:** ${text(item.row.cells[c.id])}`).join(" · "), "");
    const body = (item.row.body ?? "").trim();
    if (body) out.push(body, "");
  }
  return out.join("\n");
}
