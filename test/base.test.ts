import { describe, expect, it } from "vitest";
import { computeView, inferType, parseBase } from "../src/core/base";
import { NEW_BASE, updateBase } from "../src/core/baseEdit";
import { record } from "./helpers";

const records = [
  record("projects/alpha.md", "---\nstatus: open\npriority: 2\ntags: [project]\ndue: 2026-11-01\n---\n"),
  record("projects/beta.md", "---\nstatus: done\npriority: 1\ntags: [project]\n---\n"),
  record("projects/gamma.md", "---\nstatus: open\npriority: 3\ntags: [project]\ndue: 2026-10-20\n---\n"),
  record("notes/idea.md", "---\nstatus: open\n---\n"),
  record("deploy/app.yaml", "name: app\nreplicas: 3\n"),
];

const BASE = `
filters:
  and:
    - file.hasTag("project")
formulas:
  score: priority * 10
properties:
  status:
    displayName: Status
views:
  - type: table
    name: Open
    filters:
      and:
        - status != "done"
    order: [file.name, status, priority, formula.score]
    sort:
      - property: priority
        direction: DESC
  - type: table
    name: All
`;

describe("views", () => {
  it("filters, orders columns and sorts", () => {
    const view = computeView(parseBase(BASE), records, { viewIndex: 0 });
    expect(view.errors).toEqual([]);
    expect(view.rows.map((r) => r.path)).toEqual(["projects/gamma.md", "projects/alpha.md"]);
    expect(view.columns.map((c) => [c.id, c.label, c.editable])).toEqual([
      ["file.name", "name", false],
      ["status", "Status", true],
      ["priority", "priority", true],
      ["formula.score", "score", false],
    ]);
    expect(view.rows[0]!.cells).toEqual({ "file.name": "gamma.md", status: "open", priority: 3, "formula.score": 30 });
  });

  it("lists files by name when a view has no columns", () => {
    const view = computeView(parseBase(BASE), records, { viewIndex: 1 });
    expect(view.rows).toHaveLength(3);
    expect(view.columns.map((c) => c.id)).toEqual(["file.name"]);
  });

  it("starts a new base as one table of every file by name", () => {
    const view = computeView(parseBase(NEW_BASE), records, { viewIndex: 0 });
    expect(view.views).toEqual([{ name: "Table", type: "table" }]);
    expect(view.rows).toHaveLength(5);
    expect(view.rows[0]!.cells).toEqual({ "file.name": "app.yaml" });
  });

  it("offers every file, note and formula property to the menus", () => {
    const view = computeView(parseBase(BASE), records, { viewIndex: 0 });
    const ids = view.properties.map((p) => p.id);
    expect(ids.slice(0, 3)).toEqual(["file.name", "file.basename", "file.path"]);
    expect(ids).toContain("replicas");
    expect(ids.at(-1)).toBe("formula.score");
    expect(view.properties.find((p) => p.id === "status")!.label).toBe("Status");
  });

  it("indexes YAML files next to Markdown", () => {
    const view = computeView(parseBase('filters: file.ext == "yaml"\nviews:\n  - type: table\n    name: x\n    order: [file.name, name, replicas]\n'), records, { viewIndex: 0 });
    expect(view.rows.map((r) => r.cells)).toEqual([{ "file.name": "app.yaml", name: "app", replicas: 3 }]);
  });

  it("sorts dates as dates and puts empty values last", () => {
    const base = parseBase("views:\n  - type: table\n    name: x\n    sort:\n      - property: due\n        direction: ASC\n");
    const view = computeView(base, records, { viewIndex: 0 });
    expect(view.rows.map((r) => r.path).slice(0, 2)).toEqual(["projects/gamma.md", "projects/alpha.md"]);
  });

  it("pages the rows, 50 by default", () => {
    const many = Array.from({ length: 120 }, (_, i) => record(`n/${String(i).padStart(3, "0")}.md`, `---\ni: ${i}\n---\n`));
    const first = computeView(parseBase(NEW_BASE), many, { viewIndex: 0 });
    expect([first.page, first.pageSize, first.pageCount, first.rows.length]).toEqual([0, 50, 3, 50]);
    expect(first.matchCount).toBe(120);
    expect(first.allUris).toBeUndefined();
    expect(computeView(parseBase(NEW_BASE), many, { viewIndex: 0, collectUris: true }).allUris).toHaveLength(120);
    const last = computeView(parseBase(NEW_BASE), many, { viewIndex: 0, page: 2 });
    expect(last.rows.map((r) => r.path)).toEqual(Array.from({ length: 20 }, (_, i) => `n/${100 + i}.md`));
    const beyond = computeView(parseBase(NEW_BASE), many, { viewIndex: 0, page: 9, pageSize: 100 });
    expect([beyond.page, beyond.rows.length]).toEqual([1, 20]);
  });

  it("searches the cells of the view across all pages", () => {
    const view = computeView(parseBase(BASE), records, { viewIndex: 1, query: "BETA", pageSize: 1, collectUris: true });
    expect(view.matchCount).toBe(1);
    expect(view.allUris).toEqual(["file:///ws/projects/beta.md"]);
    expect(view.rows.map((r) => r.path)).toEqual(["projects/beta.md"]);
    expect(view.total).toBe(3);
  });

  it("hands the filters to the editor as a model", () => {
    const view = computeView(parseBase(BASE), records, { viewIndex: 0 });
    expect(view.baseFilter).toEqual({ kind: "group", conj: "and", children: [{ kind: "cond", property: "file.tags", op: "hasTag", value: "project" }] });
    expect(view.viewFilter.children[0]).toEqual({ kind: "cond", property: "status", op: "isNot", value: "done" });
  });

  it("supports or/not and limit", () => {
    const base = parseBase(`
filters:
  or:
    - file.inFolder("notes")
    - priority == 1
views:
  - type: table
    name: x
    filters:
      not:
        - file.ext == "yaml"
    limit: 1
`);
    const view = computeView(base, records, { viewIndex: 0 });
    expect(view.total).toBe(2);
    expect(view.rows).toHaveLength(1);
  });

  it("reports an unsupported filter instead of failing", () => {
    const view = computeView(parseBase("filters: file.hasLink(this)"), records, { viewIndex: 0 });
    expect(view.rows).toHaveLength(0);
    expect(view.errors[0]).toMatch(/Unsupported: file.hasLink/);
  });
});

describe("editing a base", () => {
  it("replaces the sort of one view and keeps the rest of the file", () => {
    const out = updateBase(BASE, [{ op: "setView", index: 1, key: "sort", value: [{ property: "status", direction: "ASC" }] }]);
    expect(out).toContain("  - type: table\n    name: All\n    sort:\n      - property: status\n        direction: ASC\n");
    expect(out).toContain("order: [file.name, status, priority, formula.score]");
    expect(updateBase(out, [{ op: "setView", index: 1, key: "sort", value: [] }])).toBe(BASE);
  });

  it("leaves lines it does not change exactly as they were", () => {
    const text = "filters:   file.ext == 'md'   # only notes\nviews:\n  - type: table\n    name: x\n";
    const out = updateBase(text, [{ op: "setView", index: 0, key: "order", value: ["file.name", "status"] }]);
    expect(out).toBe(text + "    order:\n      - file.name\n      - status\n");
  });

  it("keeps a flow list of columns a flow list", () => {
    const out = updateBase(BASE, [{ op: "setView", index: 0, key: "order", value: ["file.name", "status"] }]);
    expect(out).toContain("    order: [file.name, status]\n");
  });

  it("adds, renames, duplicates and removes views", () => {
    let out = updateBase(NEW_BASE, [{ op: "addView", name: "Second" }]);
    expect(out).toBe(NEW_BASE + "  - type: table\n    name: Second\n    order:\n      - file.name\n");
    out = updateBase(out, [{ op: "setView", index: 1, key: "name", value: "Renamed" }]);
    out = updateBase(out, [{ op: "setView", index: 1, key: "limit", value: 10 }]);
    out = updateBase(out, [{ op: "duplicateView", index: 1, name: "Copy" }]);
    expect(parseBase(out).views.map((v) => [v.name, v.limit])).toEqual([["Table", undefined], ["Renamed", 10], ["Copy", 10]]);
    out = updateBase(out, [{ op: "removeView", index: 0 }]);
    expect(parseBase(out).views.map((v) => v.name)).toEqual(["Renamed", "Copy"]);
    expect(() => updateBase(NEW_BASE, [{ op: "removeView", index: 0 }])).toThrow(/at least one view/);
  });

  it("sets and removes filters for the base and for a view", () => {
    let out = updateBase(NEW_BASE, [{ op: "setBaseFilters", filters: { and: ['file.ext == "md"'] } }]);
    expect(out).toBe('filters:\n  and:\n    - file.ext == "md"\n' + NEW_BASE);
    out = updateBase(out, [{ op: "setView", index: 0, key: "filters", value: { or: ['!status.isEmpty()'] } }]);
    expect(out).toContain("    name: Table\n    filters:\n      or:\n        - \"!status.isEmpty()\"\n    order:\n");
    expect(parseBase(out).views[0]!.filters).toEqual({ or: ["!status.isEmpty()"] });
    out = updateBase(out, [{ op: "setBaseFilters", filters: undefined }, { op: "setView", index: 0, key: "filters", value: undefined }]);
    expect(out).toBe(NEW_BASE);
  });

  it("adds a formula, and removing it drops its column and sort", () => {
    let out = updateBase(NEW_BASE, [
      { op: "setFormula", name: "twice", expr: "priority * 2" },
      { op: "setView", index: 0, key: "order", value: ["file.name", "formula.twice"] },
      { op: "setView", index: 0, key: "sort", value: [{ property: "formula.twice", direction: "DESC" }] },
    ]);
    expect(parseBase(out).formulas).toEqual({ twice: "priority * 2" });
    expect(out.startsWith("formulas:\n  twice: priority * 2\nviews:\n")).toBe(true);
    out = updateBase(out, [{ op: "setFormula", name: "twice", expr: undefined }]);
    expect(out).toBe(NEW_BASE);
  });
});

describe("column types", () => {
  it("infers the type most values share", () => {
    expect(inferType("x", [true, false, undefined])).toBe("checkbox");
    expect(inferType("x", [1, 2.5])).toBe("number");
    expect(inferType("x", ["2026-10-07", "2025-01-01"])).toBe("date");
    expect(inferType("x", ["2026-10-07T10:00", "2026-10-07 09:30:00"])).toBe("datetime");
    expect(inferType("x", [["a"], "b"])).toBe("list");
    expect(inferType("x", [{ a: 1 }])).toBe("object");
    expect(inferType("x", ["a", 1])).toBe("text");
    expect(inferType("x", [])).toBe("text");
    expect(inferType("tags", [])).toBe("list");
  });

  it("types the columns of a view and suggests their values", () => {
    const base = parseBase("views:\n  - type: table\n    name: x\n    order: [file.name, status, priority, tags, due]\n");
    const view = computeView(base, records, { viewIndex: 0 });
    expect(view.columns.map((c) => [c.id, c.type])).toEqual([["file.name", "text"], ["status", "text"], ["priority", "number"], ["tags", "list"], ["due", "date"]]);
    expect(view.columns[1]!.suggestions).toEqual(["open", "done"]);
    expect(view.columns[3]!.suggestions).toEqual(["project"]);
    expect(view.columns[0]!.suggestions).toBeUndefined();
  });
});
