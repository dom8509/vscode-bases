import { describe, expect, it } from "vitest";
import { makeNoteLinkResolver } from "../src/core/links";
import { bodyLinks } from "../src/core/record";
import { record } from "./helpers";

describe("bodyLinks", () => {
  it("finds wikilinks, embeds and Markdown links, each once", () => {
    const text = "See [[Alpha]], [[Beta|the beta]] and [[Alpha#Intro]].\n![[gamma]] and [doc](sub/Delta%20One.md) [doc](sub/Delta%20One.md)";
    expect(bodyLinks(text)).toEqual(["Alpha", "Beta", "gamma", "sub/Delta One.md"]);
  });

  it("skips web links, links to own headings and code", () => {
    const text = "[site](https://x.org) [mail](mailto:a@b.c) [[#Top]]\n`[[inline]]`\n```\n[[fenced]]\n```\n[[after]]";
    expect(bodyLinks(text)).toEqual(["after"]);
  });

  it("is part of a Markdown record, with or without frontmatter", () => {
    expect(record("a.md", "---\ntype: x\n---\nsee [[b]]").links).toEqual(["b"]);
    expect(record("a.md", "see [[b]]").links).toEqual(["b"]);
    expect(record("a.md", "---\nlink: \"[[b]]\"\n---\nno links").links).toBeUndefined();
    expect(record("a.yml", "a: 1").links).toBeUndefined();
  });
});

describe("makeNoteLinkResolver", () => {
  const resolve = makeNoteLinkResolver(["notes/a.md", "notes/sub/b.md", "c.md", "x/dup.md", "y/dup.md"]);

  it("resolves paths from the root, from the note's folder and by name", () => {
    expect(resolve("", "notes/a")).toBe("notes/a.md");
    expect(resolve("notes", "sub/b.md")).toBe("notes/sub/b.md");
    expect(resolve("notes/sub", "../a.md")).toBe("notes/a.md");
    expect(resolve("notes", "B")).toBe("notes/sub/b.md");
    expect(resolve("notes", "c")).toBe("c.md");
  });

  it("gives undefined for missing and ambiguous names", () => {
    expect(resolve("", "missing")).toBeUndefined();
    expect(resolve("", "dup")).toBeUndefined();
    expect(resolve("", "x/dup")).toBe("x/dup.md");
  });
});
