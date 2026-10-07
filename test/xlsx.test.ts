import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { Column, Row } from "../src/core/base";
import { toXlsx } from "../src/core/xlsx";

const columns: Column[] = [
  { id: "file.name", label: "name", editable: false, type: "text" },
  { id: "priority", label: "Priority", editable: true, type: "number" },
  { id: "done", label: "Done", editable: true, type: "checkbox" },
  { id: "due", label: "Due", editable: true, type: "date" },
  { id: "tags", label: "Tags", editable: true, type: "list" },
];
const rows: Row[] = [
  { uri: "a", path: "a.md", cells: { "file.name": "a & <b>.md", priority: 2, done: true, due: "2026-11-01", tags: ["x", "y"] } },
  { uri: "b", path: "b.md", cells: { "file.name": "b.md", priority: null, done: false, due: null, tags: [] } },
];

describe("xlsx", () => {
  const files = unzipSync(toXlsx(columns, rows, "Projects: open"));
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);

  it("is a workbook with one sheet", () => {
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('<sheet name="Projects  open"');
  });

  it("writes typed cells, escaped text and a filtered, frozen header", () => {
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>name</t></is></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">a &amp; &lt;b&gt;.md</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>2</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="D2" s="2"><v>46327</v></c>');
    expect(sheet).toContain('<c r="E2" t="inlineStr"><is><t xml:space="preserve">x, y</t></is></c>');
    expect(sheet).toContain('<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">b.md</t></is></c><c r="C3" t="b"><v>0</v></c></row>');
    expect(sheet).toContain('<autoFilter ref="A1:E3"/>');
    expect(sheet).toContain('state="frozen"');
  });
});
