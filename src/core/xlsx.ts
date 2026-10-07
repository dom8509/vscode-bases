// A view as an Excel workbook (.xlsx): one sheet, a bold header row that
// stays in view, a filter on every column, and typed cells — numbers as
// numbers, checkboxes as TRUE/FALSE, dates as dates. Written by hand: an
// .xlsx is a zip of a few small XML files.

import { strToU8, zipSync } from "fflate";
import type { Column, Row } from "./base";

function xml(s: string): string {
  // Characters XML 1.0 does not allow are dropped.
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(text).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A1, B1, …, Z1, AA1. */
function ref(col: number, row: number): string {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return `${name}${row + 1}`;
}

/** Days since 1899-12-30, Excel's date number; undefined when the text is no date. */
function excelDate(s: string): { serial: number; time: boolean } | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(s.trim());
  if (!m) return undefined;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (Number.isNaN(ms)) return undefined;
  return { serial: ms / 86_400_000 + 25_569, time: m[4] !== undefined };
}

// Style ids in styles.xml: 0 plain, 1 bold header, 2 date, 3 date and time, 4 wrapped text.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FFBFBFBF"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(c: Column, v: unknown, at: string): string {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${at}"><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${at}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "string" && (c.type === "date" || c.type === "datetime" || c.id.startsWith("file.") && /time$/.test(c.id))) {
    const d = excelDate(v);
    if (d) return `<c r="${at}" s="${d.time ? 3 : 2}"><v>${d.serial}</v></c>`;
  }
  const s = text(v);
  return `<c r="${at}" t="inlineStr"${s.includes("\n") ? ' s="4"' : ""}><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
}

export function toXlsx(columns: Column[], rows: Row[], sheetName: string): Uint8Array {
  const header = `<row r="1">${columns.map((c, i) => `<c r="${ref(i, 0)}" t="inlineStr" s="1"><is><t>${xml(c.label)}</t></is></c>`).join("")}</row>`;
  const body = rows.map((row, ri) => `<row r="${ri + 2}">${columns.map((c, ci) => cell(c, row.cells[c.id], ref(ci, ri + 1))).join("")}</row>`).join("");
  // Each column as wide as its longest text, within reason.
  const widths = columns.map((c) => Math.min(60, Math.max(8, c.label.length + 2, ...rows.slice(0, 500).map((r) => text(r.cells[c.id]).length + 2))));
  const last = ref(Math.max(columns.length - 1, 0), rows.length);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${header}${body}</sheetData>
${columns.length > 0 ? `<autoFilter ref="A1:${last}"/>` : ""}
</worksheet>`;
  // Sheet names: at most 31 characters, none of []:*?/\
  const name = xml(sheetName.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet1");
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>
${columns.length > 0 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${last.replace(/\d+$/, "")}$${rows.length + 1}</definedName></definedNames>` : ""}
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": sheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
}
