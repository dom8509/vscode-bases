// A view as text: CSV for a file, tab-separated for the clipboard (it pastes
// into a spreadsheet as cells).

import type { Column, Row } from "./base";

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(text).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** RFC 4180: a field with the separator, a quote or a line break is quoted, and quotes doubled. */
function field(s: string, sep: string): string {
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toDelimited(columns: Column[], rows: Row[], sep: "," | "\t"): string {
  const lines = [columns.map((c) => field(c.label, sep)), ...rows.map((r) => columns.map((c) => field(text(r.cells[c.id]), sep)))];
  return lines.map((l) => l.join(sep)).join("\r\n") + "\r\n";
}
