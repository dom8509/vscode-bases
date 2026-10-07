import { describe, expect, it } from "vitest";
import { ExprError, run, type EvalContext } from "../src/core/expr";
import { fileInfo } from "./helpers";

function ctx(note: Record<string, unknown> = {}, path = "projects/alpha/plan.md"): EvalContext {
  const tags = Array.isArray(note.tags) ? (note.tags as string[]).map((t) => t.toLowerCase()) : [];
  return {
    file: fileInfo(path),
    note,
    tags,
    now: new Date(2026, 9, 7, 12, 0),
    formula: (name) => (name === "double" ? Number(note.n) * 2 : null),
  };
}

describe("expressions", () => {
  it("compares note properties, bare and namespaced", () => {
    const c = ctx({ status: "done", priority: 2 });
    expect(run('status == "done"', c)).toBe(true);
    expect(run('note.status != "done"', c)).toBe(false);
    expect(run("priority >= 2 && priority < 3", c)).toBe(true);
    expect(run('note["status"] == "done"', c)).toBe(true);
  });

  it("treats a missing property as empty, not as an error", () => {
    const c = ctx({});
    expect(run('status == "done"', c)).toBe(false);
    expect(run("status.isEmpty()", c)).toBe(true);
    expect(run("priority > 1", c)).toBe(false);
    expect(run('tags.contains("x")', c)).toBe(false);
  });

  it("knows the file namespace", () => {
    const c = ctx({ tags: ["Project/Alpha"] });
    expect(run('file.ext == "md"', c)).toBe(true);
    expect(run('file.name == "plan.md" && file.basename == "plan"', c)).toBe(true);
    expect(run('file.inFolder("projects")', c)).toBe(true);
    expect(run('file.inFolder("proj")', c)).toBe(false);
    expect(run('file.hasTag("project")', c)).toBe(true);
    expect(run('file.hasTag("#project/alpha")', c)).toBe(true);
    expect(run('file.hasProperty("tags")', c)).toBe(true);
  });

  it("calls methods on strings and lists", () => {
    const c = ctx({ title: "Hello World", tags: ["a", "b"] });
    expect(run('title.lower().contains("world")', c)).toBe(true);
    expect(run('tags.containsAll("a", "b")', c)).toBe(true);
    expect(run('tags.containsAny("x", "b")', c)).toBe(true);
    expect(run("tags.length", c)).toBe(2);
    expect(run('tags.join("|")', c)).toBe("a|b");
    expect(run("!tags.isEmpty()", c)).toBe(true);
  });

  it("does date arithmetic with durations", () => {
    const c = ctx({ due: "2026-10-01" });
    expect(run('date(due) < now() - "3 days"', c)).toBe(true);
    expect(run('date(due) > now() - "1 week"', c)).toBe(true);
    expect(run('due < "2026-10-05"', c)).toBe(true);
    expect(run("date(due).year", c)).toBe(2026);
    expect(run('date(due).format("DD.MM.YYYY")', c)).toBe("01.10.2026");
  });

  it("evaluates if(), formulas and arithmetic", () => {
    const c = ctx({ n: 21 });
    expect(run("formula.double", c)).toBe(42);
    expect(run('if(n > 20, "big", "small")', c)).toBe("big");
    expect(run("(n + 4) * 2 % 7", c)).toBe(1);
    expect(run('"#" + n', c)).toBe("#21");
  });

  it("names what it does not support", () => {
    expect(() => run("file.hasLink(x)", ctx())).toThrow(/Unsupported: file.hasLink/);
    expect(() => run("link(x)", ctx())).toThrow(ExprError);
    expect(() => run("a ==", ctx())).toThrow(/Unexpected end/);
  });
});
