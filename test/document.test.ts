import { describe, expect, it } from "vitest";
import type { Column, Row } from "../src/core/base";
import { chapterOf, compareChapters, outline } from "../src/core/chapters";
import { nextId } from "../src/core/autoId";
import { documentMarkdown } from "../src/core/document";
import { bodyText } from "../src/core/record";

const col = (id: string, type: Column["type"] = "text"): Column => ({ id, label: id, editable: true, type });
const row = (id: string, cells: Record<string, unknown>, body?: string): Row => ({ uri: id, path: `${id}.md`, cells, body });

describe("chapters", () => {
  it("reads a number and a title", () => {
    expect(chapterOf("3.2 Anmeldung")).toEqual({ key: "3.2", path: [3, 2], title: "Anmeldung" });
    expect(chapterOf("3.")).toEqual({ key: "3", path: [3], title: "" });
    expect(chapterOf("Allgemein")).toEqual({ key: "Allgemein", title: "Allgemein" });
  });

  it("sorts in reading order, plain groups after chapters, no value last", () => {
    const values = ["4", "3.10", "Anhang", null, "3.2 Anmeldung", "3", "3.9"];
    expect([...values].sort(compareChapters)).toEqual(["3", "3.2 Anmeldung", "3.9", "3.10", "4", "Anhang", null]);
  });

  it("puts a heading where each chapter starts, with the chapters above it", () => {
    const rows = [row("a", { k: "3.1" }), row("b", { k: "3.1" }), row("c", { k: "3.2 Anmeldung" }), row("d", { k: "5" })];
    const items = outline(rows, "k", ["3 Funktionen"]).map((i) => (i.kind === "row" ? i.row.uri : `${i.level}:${i.number} ${i.title}`));
    expect(items).toEqual(["1:3 Funktionen", "2:3.1 ", "a", "b", "2:3.2 Anmeldung", "c", "1:5 ", "d"]);
  });
});

describe("auto id", () => {
  it("continues the highest ID with its prefix and width", () => {
    expect(nextId(["REQ-001", "REQ-041", "REQ-007", null])).toBe("REQ-042");
    expect(nextId(["REQ-9"])).toBe("REQ-10");
  });

  it("is undefined for plain numbers or mixed values", () => {
    expect(nextId([1, 2, 3])).toBeUndefined();
    expect(nextId(["open", "done", "REQ-1"])).toBeUndefined();
    expect(nextId([])).toBeUndefined();
  });
});

describe("document", () => {
  it("reads the text after the frontmatter", () => {
    expect(bodyText("---\na: 1\n---\n\nHello\n", "markdown")).toBe("Hello\n");
    expect(bodyText("No frontmatter", "markdown")).toBe("No frontmatter");
    expect(bodyText("a: 1\n", "yaml")).toBe("");
  });

  it("writes chapters, titles, properties and text as Markdown", () => {
    const columns = [col("id"), col("titel"), col("prio")];
    const rows = [row("a", { id: "REQ-001", titel: "Login", prio: "hoch", k: "3.1 Anmeldung" }, "Das System muss …\n")];
    expect(documentMarkdown("Lastenheft", columns, rows, col("k"))).toBe(
      "# Lastenheft\n\n## 3\n\n### 3.1 Anmeldung\n\n#### REQ-001 Login\n\n**prio:** hoch\n\nDas System muss …\n",
    );
  });
});
