import { describe, expect, it } from "vitest";
import { parseBase } from "../src/core/base";
import { newNote, noteText } from "../src/core/newNote";

describe("new note", () => {
  it("takes the values the filters ask for, and only those every file must meet", () => {
    const base = parseBase(`
filters:
  and:
    - file.hasTag("project")
    - file.inFolder("projects")
views:
  - type: table
    name: Open
    filters:
      and:
        - status == "open"
        - priority == 2
        - file.name.contains("x")
        - or:
            - owner == "dom"
            - owner == "anna"
`);
    const note = newNote(base, 0);
    expect(note).toEqual({ properties: { tags: ["project"], status: "open", priority: 2 }, folder: "projects" });
    expect(noteText(note.properties)).toBe("---\ntags:\n  - project\nstatus: open\npriority: 2\n---\n\n");
  });

  it("is empty without filters", () => {
    expect(newNote(parseBase("views:\n  - type: table\n    name: All\n"), 0)).toEqual({ properties: {} });
    expect(noteText({})).toBe("");
  });
});
