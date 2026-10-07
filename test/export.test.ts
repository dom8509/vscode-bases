import { describe, expect, it } from "vitest";
import type { Column, Row } from "../src/core/base";
import { toDelimited } from "../src/core/export";

const columns: Column[] = [
  { id: "file.name", label: "name", editable: false, type: "text" },
  { id: "tags", label: "Tags", editable: true, type: "list" },
  { id: "note", label: "Note", editable: true, type: "text" },
];
const rows: Row[] = [
  { uri: "a", path: "a.md", cells: { "file.name": "a.md", tags: ["x", "y"], note: 'say "hi"' } },
  { uri: "b", path: "b.md", cells: { "file.name": "b.md", tags: null, note: "two\nlines" } },
];

describe("export", () => {
  it("writes CSV with a header and quotes what needs it", () => {
    expect(toDelimited(columns, rows, ",")).toBe('name,Tags,Note\r\na.md,"x, y","say ""hi"""\r\nb.md,,"two\nlines"\r\n');
  });

  it("writes tab-separated text for the clipboard", () => {
    expect(toDelimited(columns, rows, "\t")).toBe('name\tTags\tNote\r\na.md\tx, y\t"say ""hi"""\r\nb.md\t\t"two\nlines"\r\n');
  });
});
