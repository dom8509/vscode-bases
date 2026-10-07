import { describe, expect, it } from "vitest";
import { computeView, parseBase } from "../src/core/base";
import { setViewSort } from "../src/core/baseEdit";
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

  it("derives columns from the properties when a view has no order", () => {
    const view = computeView(parseBase(BASE), records, { viewIndex: 1 });
    expect(view.rows).toHaveLength(3);
    expect(view.columns.map((c) => c.id)).toEqual(["file.name", "priority", "status", "tags", "due"]);
  });

  it("indexes YAML files next to Markdown", () => {
    const view = computeView(parseBase('filters: file.ext == "yaml"'), records, { viewIndex: 0 });
    expect(view.rows.map((r) => r.cells)).toEqual([{ "file.name": "app.yaml", name: "app", replicas: 3 }]);
  });

  it("sorts dates as dates and puts empty values last", () => {
    const base = parseBase("views:\n  - type: table\n    name: x\n    sort:\n      - property: due\n        direction: ASC\n");
    const view = computeView(base, records, { viewIndex: 0 });
    expect(view.rows.map((r) => r.path).slice(0, 2)).toEqual(["projects/gamma.md", "projects/alpha.md"]);
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
    const out = setViewSort(BASE, 1, [{ property: "status", direction: "ASC" }]);
    expect(out).toContain("  - type: table\n    name: All\n    sort:\n      - property: status\n        direction: ASC\n");
    expect(out).toContain("order: [file.name, status, priority, formula.score]");
    expect(setViewSort(out, 1, [])).not.toContain("property: status");
  });
});

describe("editing a base by hand-formatted text", () => {
  it("leaves lines it does not change exactly as they were", () => {
    const text = "filters:   file.ext == 'md'   # only notes\nviews:\n  - type: table\n    name: x\n";
    const out = setViewSort(text, 0, [{ property: "status", direction: "DESC" }]);
    expect(out.startsWith("filters:   file.ext == 'md'   # only notes\n")).toBe(true);
    expect(out).toContain("    sort:\n      - property: status\n        direction: DESC\n");
  });
});
