import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { computeView, parseBase } from "../src/core/base";
import { ExprError, run, type EvalContext } from "../src/core/expr";
import { LinkGraph, makeResolver, readLinks } from "../src/core/links";
import { fileInfo, record } from "./helpers";

const SQL = await initSqlJs();

/** An SQLite file, as bytes, made from SQL statements. */
function database(sql: string): Uint8Array {
  const db = new SQL.Database();
  db.run(sql);
  const bytes = db.export();
  db.close();
  return bytes;
}

const PATHS = ["req/REQ-001.md", "req/REQ-002.md", "test/T-1.md", "design/D-1.md"];

describe("reading links from a database", () => {
  it("takes source, target and type by name, whatever the table looks like", () => {
    const bytes = database(`
      CREATE TABLE refs (id INTEGER, kind TEXT, to_file TEXT, from_file TEXT);
      INSERT INTO refs VALUES (1, 'tests', 'req/REQ-001.md', 'test/T-1.md'), (2, NULL, 'req/REQ-002.md', 'req/REQ-001.md');
    `);
    const rows = readLinks(SQL, bytes, "SELECT from_file AS source, to_file AS target, kind AS type FROM refs ORDER BY id");
    expect(rows).toEqual([
      { source: "test/T-1.md", target: "req/REQ-001.md", type: "tests" },
      { source: "req/REQ-001.md", target: "req/REQ-002.md", type: "" },
    ]);
  });

  it("takes the first two columns when they have other names, and needs no type", () => {
    const bytes = database("CREATE TABLE l (a TEXT, b TEXT); INSERT INTO l VALUES ('x.md', 'y.md'), (NULL, 'z.md');");
    expect(readLinks(SQL, bytes, "SELECT a, b FROM l")).toEqual([{ source: "x.md", target: "y.md", type: "" }]);
  });

  it("reports a query that does not work", () => {
    const bytes = database("CREATE TABLE l (a TEXT);");
    expect(() => readLinks(SQL, bytes, "SELECT * FROM nope")).toThrow(/no such table/);
    expect(() => readLinks(SQL, bytes, "SELECT a FROM l")).toThrow(/source and target/);
  });

  it("does not change the file it reads", () => {
    const bytes = database("CREATE TABLE l (source TEXT, target TEXT); INSERT INTO l VALUES ('a', 'b');");
    const before = [...bytes];
    readLinks(SQL, bytes, "DELETE FROM l RETURNING source, target");
    expect([...bytes]).toEqual(before);
  });
});

describe("matching links to files", () => {
  const resolve = makeResolver(PATHS, "db", (abs) => (abs.startsWith("/ws/") ? abs.slice(4) : undefined));

  it("finds a file by its path, from the workspace or from the database's folder", () => {
    expect(resolve("req/REQ-001.md")).toBe("req/REQ-001.md");
    expect(resolve("./req/REQ-001.md")).toBe("req/REQ-001.md");
    expect(resolve("../req/REQ-002.md")).toBe("req/REQ-002.md");
    expect(resolve("req\\REQ-002.md")).toBe("req/REQ-002.md");
    expect(resolve("/ws/test/T-1.md")).toBe("test/T-1.md");
  });

  it("finds a file by its name, without .md, or as a wiki link", () => {
    expect(resolve("req/REQ-001")).toBe("req/REQ-001.md");
    expect(resolve("REQ-002")).toBe("req/REQ-002.md");
    expect(resolve("T-1.md")).toBe("test/T-1.md");
    expect(resolve("[[D-1|the design]]")).toBe("design/D-1.md");
  });

  it("keeps a value no file matches, and a name two files share", () => {
    const twice = makeResolver(["a/x.md", "b/x.md"], "", () => undefined);
    expect(twice("x")).toBe("x");
    expect(resolve("gone/nothing.md")).toBe("gone/nothing.md");
  });
});

const graph = new LinkGraph(
  [
    { source: "test/T-1.md", target: "REQ-001", type: "tests" },
    { source: "design/D-1.md", target: "REQ-001", type: "implements" },
    { source: "req/REQ-001.md", target: "REQ-002", type: "refines" },
    { source: "req/REQ-001.md", target: "REQ-002", type: "depends" },
  ],
  makeResolver(PATHS, "", () => undefined),
);

function ctx(path: string, links: LinkGraph | null = graph): EvalContext {
  return { file: fileInfo(path), note: {}, tags: [], now: new Date(), formula: () => null, links: links ?? undefined };
}

describe("links in expressions", () => {
  it("lists links and backlinks, of all types or only some", () => {
    expect(run("file.links", ctx("req/REQ-001.md"))).toEqual(["req/REQ-002.md"]);
    expect(run("file.backlinks", ctx("req/REQ-001.md"))).toEqual(["test/T-1.md", "design/D-1.md"]);
    expect(run('file.backlinks("tests")', ctx("req/REQ-001.md"))).toEqual(["test/T-1.md"]);
    expect(run('file.backlinks("tests", "implements")', ctx("req/REQ-001.md"))).toEqual(["test/T-1.md", "design/D-1.md"]);
    expect(run('file.backlinks(["implements"])', ctx("req/REQ-001.md"))).toEqual(["design/D-1.md"]);
    expect(run("file.links()", ctx("test/T-1.md"))).toEqual(["req/REQ-001.md"]);
    expect(run('file.links("nope")', ctx("test/T-1.md"))).toEqual([]);
  });

  it("filters on links: hasLink, list methods, isEmpty", () => {
    expect(run('file.hasLink("REQ-001")', ctx("test/T-1.md"))).toBe(true);
    expect(run('file.hasLink("req/REQ-001.md", "implements")', ctx("test/T-1.md"))).toBe(false);
    expect(run("file.hasLink(this.file)", { ...ctx("test/T-1.md"), thisFile: fileInfo("req/REQ-001.md") })).toBe(true);
    expect(run('file.backlinks("tests").isEmpty()', ctx("req/REQ-002.md"))).toBe(true);
    expect(run("file.backlinks.length", ctx("req/REQ-001.md"))).toBe(2);
  });

  it("says what is missing when there is no database, or it could not be read", () => {
    expect(() => run("file.links", ctx("a.md", null))).toThrow(ExprError);
    expect(() => run("file.links", ctx("a.md", null))).toThrow(/bases\.links\.database/);
    expect(() => run('file.backlinks("x")', ctx("a.md", new LinkGraph([], undefined, "no such table: links")))).toThrow(/no such table/);
  });
});

describe("links in a view", () => {
  const records = PATHS.map((p) => record(p, "---\nx: 1\n---\n"));
  const base = parseBase(`
views:
  - type: table
    name: Untested
    filters: 'file.inFolder("req") && file.backlinks("tests").isEmpty()'
    order: [file.name, file.links, file.backlinks("tests")]
`);

  it("filters and shows links as columns of paths that open their files", () => {
    const r = computeView(base, records, { viewIndex: 0, links: graph });
    expect(r.rows.map((x) => x.path)).toEqual(["req/REQ-002.md"]);
    expect(r.columns.find((c) => c.id === "file.links")).toMatchObject({ type: "list", links: true, editable: false });
    expect(r.errors).toEqual([]);
    const all = computeView(parseBase("views:\n  - type: table\n    order: [file.name, file.backlinks]\n"), records, { viewIndex: 0, links: graph });
    expect(all.rows.find((x) => x.path === "req/REQ-001.md")!.cells["file.backlinks"]).toEqual(["test/T-1.md", "design/D-1.md"]);
  });

  it("offers links, backlinks and each link type as properties", () => {
    const ids = computeView(base, records, { viewIndex: 0, links: graph }).properties.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["file.links", "file.backlinks", 'file.links("tests")', 'file.backlinks("refines")']));
    expect(computeView(base, records, { viewIndex: 0 }).properties.map((p) => p.id)).not.toContain("file.links");
  });
});
