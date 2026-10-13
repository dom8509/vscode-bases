import { describe, expect, it } from "vitest";
import { computeView, parseBase, usesNoteText } from "../src/core/base";
import { bodyText } from "../src/core/record";
import { codeblock, parsePath, pathLabel, section, sectionArg, sectionId, sectionPath } from "../src/core/sections";
import { record } from "./helpers";

const NOTE = `# Login

Intro.

## Text

The user signs in.

\`\`\`text
Given a user
When they sign in
\`\`\`

### Detail

More.

## Test

\`\`\`text
other block
\`\`\`

\`\`\`gherkin
Feature: x
## not a heading
\`\`\`
`;

describe("note sections", () => {
  it("finds the text under a heading, with its subheadings", () => {
    expect(section(NOTE, "Text")).toBe("The user signs in.\n\n```text\nGiven a user\nWhen they sign in\n```\n\n### Detail\n\nMore.");
    expect(section(NOTE, "## text")).toBe(section(NOTE, "Text"));
    expect(section(NOTE, "### Text")).toBeUndefined();
    expect(section(NOTE, "Detail")).toBe("More.");
    expect(section(NOTE, "Missing")).toBeUndefined();
    expect(section(NOTE, "")).toBeUndefined();
  });

  it("ignores headings inside code blocks", () => {
    expect(section(NOTE, "not a heading")).toBeUndefined();
    expect(section(NOTE, "Test")).toContain("## not a heading");
  });

  it("finds a code block by language and number", () => {
    expect(codeblock(NOTE, "text")).toBe("Given a user\nWhen they sign in");
    expect(codeblock(NOTE, "text", 2)).toBe("other block");
    expect(codeblock(NOTE, "gherkin")).toBe("Feature: x\n## not a heading");
    expect(codeblock(NOTE, "")).toBe("Given a user\nWhen they sign in");
    expect(codeblock(NOTE, "python")).toBeUndefined();
  });
});

describe("section paths", () => {
  it("reads headings and a closing code block", () => {
    expect(parsePath("Login > ## Text > ```text[2]")).toEqual([
      { kind: "heading", title: "Login" },
      { kind: "heading", title: "Text", level: 2 },
      { kind: "code", lang: "text", index: 2 },
    ]);
    expect(parsePath("```")).toEqual([{ kind: "code", lang: "", index: 1 }]);
    expect(parsePath("A \\> B")).toEqual([{ kind: "heading", title: "A > B" }]);
    expect(() => parsePath("```text > Text")).toThrow(/ends the path/);
    expect(() => parsePath("Text >")).toThrow(/empty/);
  });

  it("goes down the headings to the part they name", () => {
    expect(sectionPath(NOTE, "Text")).toBe(section(NOTE, "Text"));
    expect(sectionPath(NOTE, "Login > Text > Detail")).toBe("More.");
    expect(sectionPath(NOTE, "Text > ```text")).toBe("Given a user\nWhen they sign in");
    expect(sectionPath(NOTE, "Test > ```text")).toBe("other block");
    expect(sectionPath(NOTE, "Test > ```")).toBe("other block");
    expect(sectionPath(NOTE, "Test > ```[2]")).toBe("Feature: x\n## not a heading");
    expect(sectionPath(NOTE, "```gherkin")).toBe("Feature: x\n## not a heading");
    expect(sectionPath(NOTE, "Detail > Text")).toBeUndefined();
    expect(sectionPath(NOTE, "Missing > ```text")).toBeUndefined();
  });

  it("names and writes columns", () => {
    expect(pathLabel("Text > Detail")).toBe("Text › Detail");
    expect(pathLabel("Test > ```text[2]")).toBe("Test › text block 2");
    expect(pathLabel("```")).toBe("code block");
    expect(sectionId('A "b" > ```text')).toBe('file.section("A \\"b\\" > ```text")');
    expect(sectionArg(sectionId('A "b" > ```text'))).toBe('A "b" > ```text');
    expect(sectionArg("file.name")).toBeUndefined();
  });

  it("shows them as columns when the host gives the note text", () => {
    const text = `---\nstatus: open\n---\n${NOTE}`;
    const rec = record("req/login.md", text);
    const base = parseBase(`
formulas:
  steps: 'file.section("Text > \`\`\`text")'
views:
  - type: table
    name: T
    order: [file.name, 'file.section("Text")', 'file.section("Test > \`\`\`text")', formula.steps, 'file.section("Text > ")']
`);
    const bodies = new Map([[rec.uri, bodyText(text, "markdown")]]);
    const result = computeView(base, [rec], { viewIndex: 0, bodies });
    expect(result.columns.map((c) => c.label)).toEqual(["name", "Text", "Test › text block", "steps", "Text > "]);
    expect(result.rows[0]!.cells['file.section("Text")']).toContain("The user signs in.");
    expect(result.rows[0]!.cells['file.section("Test > ```text")']).toBe("other block");
    expect(result.rows[0]!.cells["formula.steps"]).toBe("Given a user\nWhen they sign in");
    expect(result.errors.join()).toContain("file.section: A step of the path is empty");

    const without = computeView(base, [rec], { viewIndex: 0 });
    expect(without.errors.join()).toContain("needs the text of the note");
  });

  it("tells when a base reads the note text", () => {
    expect(usesNoteText('order: [file.section("Text")]')).toBe(true);
    expect(usesNoteText("order: [file.name]")).toBe(false);
  });
});
