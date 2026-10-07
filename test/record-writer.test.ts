import { describe, expect, it } from "vitest";
import { applyEdits, parseInputValue, type PropertyEdit } from "../src/core/writer";
import { record } from "./helpers";

function edit(text: string, ext: string, edits: PropertyEdit[]): string {
  const change = applyEdits(text, ext, edits);
  if (!change) return text;
  return text.slice(0, change.start) + change.text + text.slice(change.end);
}

const NOTE = `---
title: "Plan"   # quoted on purpose
status: open
tags: [project, alpha]
---
# Plan

Body with --- inside.
`;

describe("records", () => {
  it("reads the frontmatter of a Markdown file", () => {
    const r = record("notes/plan.md", NOTE);
    expect(r.properties).toEqual({ title: "Plan", status: "open", tags: ["project", "alpha"] });
    expect(r.tags).toEqual(["project", "alpha"]);
    expect(r.readOnly).toBeUndefined();
  });

  it("gives a Markdown file without frontmatter an empty record", () => {
    expect(record("a.md", "# Just text\n").properties).toEqual({});
  });

  it("reads the top level of a YAML file", () => {
    expect(record("cfg/app.yaml", "name: app\nreplicas: 3\n").properties).toEqual({ name: "app", replicas: 3 });
  });

  it("marks what it cannot edit", () => {
    expect(record("list.yaml", "- a\n- b\n").readOnly).toMatch(/not a mapping/);
    expect(record("multi.yaml", "a: 1\n---\nb: 2\n").readOnly).toMatch(/Multi-document/);
    expect(record("broken.md", "---\na: [\n---\n").readOnly).toMatch(/YAML error/);
  });
});

describe("writer", () => {
  it("changes a value and leaves everything else as it was", () => {
    const out = edit(NOTE, "md", [{ kind: "set", key: "status", value: "done" }]);
    expect(out).toBe(NOTE.replace("status: open", "status: done"));
  });

  it("keeps the quoting and comment of a replaced scalar", () => {
    const out = edit(NOTE, "md", [{ kind: "set", key: "title", value: "Roadmap" }]);
    expect(out).toContain('title: "Roadmap" # quoted on purpose');
  });

  it("keeps a flow list a flow list", () => {
    const out = edit(NOTE, "md", [{ kind: "set", key: "tags", value: ["project", "beta"] }]);
    expect(out).toContain("tags: [project, beta]");
  });

  it("adds, renames and deletes properties", () => {
    let out = edit(NOTE, "md", [{ kind: "set", key: "owner", value: "dom" }]);
    expect(out).toContain("tags: [project, alpha]\nowner: dom\n---\n");
    out = edit(out, "md", [{ kind: "rename", from: "status", to: "state" }]);
    expect(out).toContain("title: \"Plan\"   # quoted on purpose\nstate: open\n");
    out = edit(out, "md", [{ kind: "delete", key: "owner" }]);
    expect(out).not.toContain("owner");
  });

  it("refuses to rename onto an existing property", () => {
    expect(() => applyEdits(NOTE, "md", [{ kind: "rename", from: "status", to: "title" }])).toThrow(/already exists/);
  });

  it("creates frontmatter where there is none", () => {
    expect(edit("# Title\n", "md", [{ kind: "set", key: "status", value: "open" }])).toBe("---\nstatus: open\n---\n# Title\n");
  });

  it("fills an empty frontmatter", () => {
    expect(edit("---\n---\nbody\n", "md", [{ kind: "set", key: "a", value: 1 }])).toBe("---\na: 1\n---\nbody\n");
  });

  it("keeps CRLF line endings", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    const out = edit(crlf, "md", [{ kind: "set", key: "owner", value: "dom" }]);
    expect(out).toContain("owner: dom\r\n---\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("edits YAML files and keeps their comments", () => {
    const yaml = "# service\nname: app # the name\nreplicas: 3\n";
    expect(edit(yaml, "yaml", [{ kind: "set", key: "replicas", value: 5 }])).toBe("# service\nname: app # the name\nreplicas: 5\n");
  });

  it("does not touch a file whose value is already set", () => {
    expect(applyEdits(NOTE, "md", [{ kind: "set", key: "status", value: "open" }])).toBeUndefined();
  });

  it("does not reflow long strings or re-indent untouched lists", () => {
    const long = `---\nsummary: ${"word ".repeat(40).trim()}\nlist:\n  - a\n  - b\nn: 1\n---\n`;
    expect(edit(long, "md", [{ kind: "set", key: "n", value: 2 }])).toBe(long.replace("n: 1", "n: 2"));
  });
});

describe("input values", () => {
  it("reads typed input as YAML", () => {
    expect(parseInputValue("3")).toBe(3);
    expect(parseInputValue("true")).toBe(true);
    expect(parseInputValue("[a, b]")).toEqual(["a", "b"]);
    expect(parseInputValue("hello world")).toBe("hello world");
    expect(parseInputValue("2026-10-07")).toBe("2026-10-07");
    expect(parseInputValue("")).toBeNull();
    expect(parseInputValue("a: [")).toBe("a: [");
  });
});
