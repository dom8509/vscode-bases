import { describe, expect, it } from "vitest";
import type { Column, Row } from "../src/core/base";
import { compareGroups, levelsOf, outline } from "../src/core/chapters";
import { nextId } from "../src/core/autoId";
import { documentMarkdown } from "../src/core/document";
import { bodyText } from "../src/core/record";

const col = (id: string, type: Column["type"] = "text"): Column => ({ id, label: id, editable: true, type });
const row = (id: string, cells: Record<string, unknown>, body?: string): Row => ({ uri: id, path: `${id}.md`, cells, body });

describe("group levels", () => {
  it("reads chapter numbers and titles by default", () => {
    expect(levelsOf("3.2 Anmeldung")).toEqual([{ key: "3", number: "3", title: "" }, { key: "3.2", number: "3.2", title: "Anmeldung" }]);
    expect(levelsOf("3.")).toEqual([{ key: "3", number: "3", title: "" }]);
    expect(levelsOf("Allgemein")).toEqual([{ key: "Allgemein", number: "", title: "Allgemein" }]);
  });

  it("splits paths at another separator, and not at all with none", () => {
    expect(levelsOf("Funktionen / Anmeldung", "/").map((l) => [l.key, l.title])).toEqual([["Funktionen", "Funktionen"], ["Funktionen/Anmeldung", "Anmeldung"]]);
    expect(levelsOf("Kunde > Login", ">").map((l) => l.title)).toEqual(["Kunde", "Login"]);
    expect(levelsOf("3.2 Anmeldung", "")).toEqual([{ key: "3.2 Anmeldung", number: "", title: "3.2 Anmeldung" }]);
  });

  it("sorts chapters in reading order, plain groups after them, no value last", () => {
    const values = ["4", "3.10", "Anhang", null, "3.2 Anmeldung", "3", "3.9"];
    expect([...values].sort((a, b) => compareGroups(a, b))).toEqual(["3", "3.2 Anmeldung", "3.9", "3.10", "4", "Anhang", null]);
  });

  it("sorts paths segment by segment, a parent before its children", () => {
    const values = ["b/a", "a/b", "a", "a/a10", "a/a9"];
    expect([...values].sort((x, y) => compareGroups(x, y, "/"))).toEqual(["a", "a/a9", "a/a10", "a/b", "b/a"]);
  });

  it("puts a heading where each chapter starts, with the chapters above it", () => {
    const rows = [row("a", { k: "3.1" }), row("b", { k: "3.1" }), row("c", { k: "3.2 Anmeldung" }), row("d", { k: "5" })];
    const items = outline(rows, "k", ["3 Funktionen"]).map((i) => (i.kind === "row" ? i.row.uri : `${i.level}:${i.number} ${i.title}`));
    expect(items).toEqual(["1:3 Funktionen", "2:3.1 ", "a", "b", "2:3.2 Anmeldung", "c", "1:5 ", "d"]);
  });

  it("nests folders as an outline", () => {
    const rows = [row("a", { f: "projects" }), row("b", { f: "projects/web" }), row("c", { f: "projects/web" }), row("d", { f: "notes" })];
    const items = outline(rows, "f", [], "/").map((i) => (i.kind === "row" ? i.row.uri : `${i.level}:${i.title}`));
    expect(items).toEqual(["1:projects", "a", "2:web", "b", "c", "1:notes", "d"]);
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
