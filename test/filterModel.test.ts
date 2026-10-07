import { describe, expect, it } from "vitest";
import { conditionExpr, fromModel, parseCondition, propertyExpr, toModel, type FilterGroup, type Operator } from "../src/core/filterModel";
import { run, type EvalContext } from "../src/core/expr";
import { fileInfo } from "./helpers";

describe("filter model", () => {
  it("writes each operator as a Bases expression and reads it back", () => {
    const cases: [string, Operator, string, string][] = [
      ["status", "is", "done", 'status == "done"'],
      ["status", "isNot", "done", 'status != "done"'],
      ["priority", "gt", "2", "priority > 2"],
      ["priority", "le", "2.5", "priority <= 2.5"],
      ["draft", "is", "true", "draft == true"],
      ["tags", "contains", "x", 'tags.contains("x")'],
      ["tags", "notContains", "x", '!tags.contains("x")'],
      ["title", "startsWith", "A", 'title.startsWith("A")'],
      ["title", "endsWith", "Z", 'title.endsWith("Z")'],
      ["owner", "isEmpty", "", "owner.isEmpty()"],
      ["owner", "isNotEmpty", "", "!owner.isEmpty()"],
      ["file.tags", "hasTag", "#project", 'file.hasTag("project")'],
      ["file.folder", "inFolder", "docs/adr", 'file.inFolder("docs/adr")'],
      ["file.ext", "is", "md", 'file.ext == "md"'],
      ["due-date", "lt", "2026-01-01", 'note["due-date"] < "2026-01-01"'],
      ["formula.score", "ge", "10", "formula.score >= 10"],
    ];
    for (const [property, op, value, expr] of cases) {
      expect(conditionExpr({ property, op, value })).toBe(expr);
      const back = parseCondition(expr);
      expect(back).toEqual({ kind: "cond", property, op, value: op === "hasTag" ? value.replace("#", "") : value });
    }
  });

  it("reads the forms people write by hand", () => {
    expect(parseCondition("status=='done'")).toEqual({ kind: "cond", property: "status", op: "is", value: "done" });
    expect(parseCondition('note.status == "x"')).toEqual({ kind: "cond", property: "status", op: "is", value: "x" });
  });

  it("keeps anything else as an expression", () => {
    for (const expr of ['status == "a" || status == "b"', "date(due) < today()", "priority > other", '!title.startsWith("x")', "file == 1"]) {
      expect(parseCondition(expr)).toEqual({ kind: "expr", expr });
    }
  });

  it("quotes property names that are not identifiers", () => {
    expect(propertyExpr("due-date")).toBe('note["due-date"]');
    expect(propertyExpr("file")).toBe('note["file"]');
    expect(propertyExpr("note.status")).toBe("status");
  });

  it("round-trips nested filter trees", () => {
    const filters = { and: ['file.hasTag("project")', { or: ['status == "open"', "date(due) < today()"] }, { not: ["owner.isEmpty()"] }] };
    const model = toModel(filters);
    expect(model.children.map((c) => c.kind)).toEqual(["cond", "group", "group"]);
    expect(fromModel(model)).toEqual(filters);
  });

  it("wraps a single expression in a group and unwraps nothing", () => {
    expect(toModel('file.ext == "md"')).toEqual({ kind: "group", conj: "and", children: [{ kind: "cond", property: "file.ext", op: "is", value: "md" }] });
    expect(toModel(undefined)).toEqual({ kind: "group", conj: "and", children: [] });
  });

  it("leaves out a condition still waiting for its value", () => {
    const model: FilterGroup = { kind: "group", conj: "and", children: [{ kind: "cond", property: "status", op: "is", value: "" }, { kind: "cond", property: "owner", op: "isEmpty", value: "" }] };
    expect(fromModel(model)).toEqual({ and: ["owner.isEmpty()"] });
  });

  it("drops empty groups and blank expressions", () => {
    const model: FilterGroup = { kind: "group", conj: "and", children: [{ kind: "group", conj: "or", children: [] }, { kind: "expr", expr: "  " }] };
    expect(fromModel(model)).toBeUndefined();
  });

  it("produces expressions the evaluator agrees with", () => {
    const ctx: EvalContext = { file: fileInfo("docs/adr/0001.md"), note: { status: "open", "due-date": "2025-12-01", tags: ["x"] }, tags: ["project"], now: new Date(), formula: () => null };
    const yes: [string, Operator, string][] = [
      ["status", "is", "open"], ["due-date", "lt", "2026-01-01"], ["tags", "contains", "x"], ["owner", "isEmpty", ""],
      ["file.folder", "inFolder", "docs"], ["file.tags", "hasTag", "project"], ["file.ext", "isNot", "yaml"],
    ];
    for (const [property, op, value] of yes) expect(run(conditionExpr({ property, op, value }), ctx)).toBe(true);
  });
});
