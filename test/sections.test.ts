import { describe, expect, it } from "vitest";
import { computeView, parseBase, usesNoteText } from "../src/core/base";
import { bodyText } from "../src/core/record";
import { codeblock, section } from "../src/core/sections";
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
  });

  it("ignores headings inside code blocks", () => {
    expect(section(NOTE, "not a heading")).toBeUndefined();
    expect(section(NOTE, "Test")).toContain("## not a heading");
  });

  it("finds a code block by language, also under a heading", () => {
    expect(codeblock(NOTE, "text")).toBe("Given a user\nWhen they sign in");
    expect(codeblock(NOTE, "text", "Test")).toBe("other block");
    expect(codeblock(NOTE, "gherkin")).toBe("Feature: x\n## not a heading");
    expect(codeblock(NOTE, "")).toBe("Given a user\nWhen they sign in");
    expect(codeblock(NOTE, "python")).toBeUndefined();
    expect(codeblock(NOTE, "text", "Missing")).toBeUndefined();
  });

  it("shows them as columns when the host gives the note text", () => {
    const text = `---\nstatus: open\n---\n${NOTE}`;
    const rec = record("req/login.md", text);
    const base = parseBase(`
formulas:
  steps: 'file.codeblock("text", "Text")'
views:
  - type: table
    name: T
    order: [file.name, 'file.section("Text")', formula.steps]
`);
    const bodies = new Map([[rec.uri, bodyText(text, "markdown")]]);
    const result = computeView(base, [rec], { viewIndex: 0, bodies });
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.cells['file.section("Text")']).toContain("The user signs in.");
    expect(result.rows[0]!.cells["formula.steps"]).toBe("Given a user\nWhen they sign in");

    const without = computeView(base, [rec], { viewIndex: 0 });
    expect(without.errors.join()).toContain("needs the text of the note");
  });

  it("tells when a base reads the note text", () => {
    expect(usesNoteText('order: [file.section("Text")]')).toBe(true);
    expect(usesNoteText("x: 'file.codeblock(\"text\")'")).toBe(true);
    expect(usesNoteText("order: [file.name]")).toBe(false);
  });
});
