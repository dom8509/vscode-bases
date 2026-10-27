import { describe, expect, it, vi } from "vitest";
import { LinkGraph } from "../src/core/links";
import { record } from "./helpers";

vi.mock("vscode", () => ({
  Disposable: { from: (...subs: { dispose(): void }[]) => ({ dispose: () => subs.forEach((s) => s.dispose()) }) },
}));

const { createApi } = await import("../src/host/api");

/** Just enough of an index and a link source for the API. */
function sources(files: Record<string, string>, rows: { source: string; target: string; type: string }[] = []) {
  const records = Object.entries(files).map(([path, text]) => record(path, text));
  const listeners: (() => void)[] = [];
  const event = (l: () => void) => {
    listeners.push(l);
    return { dispose: () => listeners.splice(listeners.indexOf(l), 1) };
  };
  const index = { all: () => records, ensureReady: async () => {}, whenScanned: async () => {}, onDidChange: event };
  const links = { links: () => (rows.length ? new LinkGraph(rows) : undefined), onDidChange: event };
  return { api: createApi(index as any, links as any), listeners };
}

describe("the API for other extensions", () => {
  it("gives every file with its properties and resolved links", () => {
    const { api } = sources(
      {
        "notes/a.md": "---\ntype: idea\ntags: [x]\n---\n[[b]] [[b|again]] [[missing]] [self](a.md) [up](../c.md)",
        "notes/b.md": "no links",
        "c.md": "",
      },
      [{ source: "notes/b.md", target: "c.md", type: "tests" }],
    );
    const files = api.files();
    expect(api.version).toBe(1);
    expect(files.map((f) => f.path)).toEqual(["notes/a.md", "notes/b.md", "c.md"]);
    expect(files[0]).toMatchObject({ basename: "a", folder: "notes", kind: "markdown", properties: { type: "idea" }, tags: ["x"] });
    expect(files[0]!.links).toEqual([{ target: "notes/b.md", type: "" }, { target: "c.md", type: "" }]);
    expect(files[1]!.links).toEqual([{ target: "c.md", type: "tests" }]);
  });

  it("tells when the index or the links change, until disposed", () => {
    const { api, listeners } = sources({ "a.md": "" });
    const seen = vi.fn();
    const sub = api.onDidChange(seen);
    listeners.forEach((l) => l());
    expect(seen).toHaveBeenCalledTimes(2);
    sub.dispose();
    expect(listeners).toHaveLength(0);
  });
});
