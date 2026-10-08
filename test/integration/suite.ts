// Runs inside VS Code: checks what the unit tests cannot, namely the real
// file search, the WorkspaceEdit path and the custom editor registration.

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { computeView, parseBase } from "../../src/core/base";
import { applyPropertyEdits } from "../../src/host/edits";
import initSqlJs from "sql.js";
import { WorkspaceIndex } from "../../src/host/indexer";
import { LinkSource } from "../../src/host/links";

async function read(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const tests: [string, (ws: vscode.Uri, index: WorkspaceIndex) => Promise<void>][] = [
  [
    "indexes every Markdown and YAML file",
    async (_ws, index) => {
      const paths = [...index.all()].map((r) => r.file.path).sort();
      assert.deepEqual(paths, [
        "deploy/app.yaml",
        "deploy/worker.yml",
        "lastenheft/REQ-001.md",
        "lastenheft/REQ-002.md",
        "lastenheft/REQ-003.md",
        "lastenheft/REQ-004.md",
        "lastenheft/REQ-005.md",
        "notes/idea.md",
        "notes/meeting.md",
        "projects/alpha.md",
        "projects/beta.md",
        "projects/gamma.md",
      ]);
    },
  ],
  [
    "computes the sample base",
    async (ws, index) => {
      const base = parseBase(await read(vscode.Uri.joinPath(ws, "projects.base")));
      const view = computeView(base, index.all(), { viewIndex: 0, now: new Date(2026, 10, 15) });
      assert.deepEqual(view.errors, []);
      assert.deepEqual(view.rows.map((r) => r.path), ["projects/gamma.md", "projects/alpha.md"]);
      assert.equal(view.rows[1]!.cells["formula.overdue"], "yes");
    },
  ],
  [
    "applies a bulk edit to files on disk and the index follows",
    async (ws, index) => {
      const alpha = vscode.Uri.joinPath(ws, "projects/alpha.md");
      const idea = vscode.Uri.joinPath(ws, "notes/idea.md");
      const app = vscode.Uri.joinPath(ws, "deploy/app.yaml");
      const outcome = await applyPropertyEdits([alpha, idea, app], [{ kind: "set", key: "reviewed", value: true }]);
      assert.deepEqual(outcome, { applied: true, changed: 3, failures: [], concurrent: [] });

      await waitFor("the edit saved to disk", async () => (await read(alpha)).includes("reviewed: true"));
      assert.equal((await read(alpha)).split("---")[1], "\ntitle: Alpha\nstatus: open\npriority: 2\nowner: dom\ntags: [project, safety]\ndue: 2026-11-01\nreviewed: true\n");
      assert.ok((await read(idea)).startsWith("---\nreviewed: true\n---\n# An idea"));
      assert.equal(await read(app), "# Deployment of the app\nname: app\nreplicas: 3 # scaled up for the release\nimage: ghcr.io/example/app:1.4.2\nreviewed: true\n");
      const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.path);
      assert.deepEqual(dirty, [], "a bulk edit leaves no unsaved files behind");

      await waitFor("the index to pick up the edit", () => index.get(idea)?.properties.reviewed === true);
    },
  ],
  [
    "reports files it cannot edit and changes the rest",
    async (ws) => {
      const broken = vscode.Uri.joinPath(ws, "notes/multi.yaml");
      await vscode.workspace.fs.writeFile(broken, new TextEncoder().encode("a: 1\n---\nb: 2\n"));
      const beta = vscode.Uri.joinPath(ws, "projects/beta.md");
      const outcome = await applyPropertyEdits([broken, beta], [{ kind: "rename", from: "owner", to: "assignee" }]);
      assert.equal(outcome.changed, 1);
      assert.match(outcome.failures[0]!, /notes\/multi.yaml: Multi-document/);
      await waitFor("the rename saved", async () => (await read(beta)).includes("assignee: anna"));
    },
  ],
  [
    "applies quick edits to one file one after the other, losing none",
    async (ws) => {
      const alpha = vscode.Uri.joinPath(ws, "projects/alpha.md");
      const outcomes = await Promise.all([
        applyPropertyEdits([alpha], [{ kind: "set", key: "status", value: "a-much-longer-status-value" }]),
        applyPropertyEdits([alpha], [{ kind: "set", key: "owner", value: "someone-else" }]),
        applyPropertyEdits([alpha, vscode.Uri.joinPath(ws, "projects/beta.md")], [{ kind: "set", key: "round", value: 2 }]),
      ]);
      assert.deepEqual(outcomes.map((o) => o.applied), [true, true, true]);
      const text = await read(alpha);
      assert.match(text, /status: a-much-longer-status-value\n/);
      assert.match(text, /owner: someone-else\n/);
      assert.match(text, /round: 2\n/);
      assert.match(await read(vscode.Uri.joinPath(ws, "projects/beta.md")), /round: 2\n/);
      assert.match(text, /^---\ntitle: Alpha\n/, "the file is intact");
    },
  ],
  [
    "writes a bulk edit of more files than VS Code keeps open to disk, all of them",
    async (ws) => {
      const uris: vscode.Uri[] = [];
      for (let i = 0; i < 300; i++) {
        const u = vscode.Uri.joinPath(ws, `many/n${i}.md`);
        await vscode.workspace.fs.writeFile(u, new TextEncoder().encode(`---\nstatus: open\nn: ${i}\n---\n# Note ${i}\n`));
        uris.push(u);
      }
      const outcome = await applyPropertyEdits(uris, [{ kind: "set", key: "status", value: "done" }]);
      assert.deepEqual(outcome, { applied: true, changed: 300, failures: [], concurrent: [] });
      let onDisk = 0;
      for (const u of uris) if ((await read(u)) === `---\nstatus: done\nn: ${uris.indexOf(u)}\n---\n# Note ${uris.indexOf(u)}\n`) onDisk++;
      assert.equal(onDisk, 300, "every file on disk holds the edit, and nothing else changed");
      assert.equal(vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.path.includes("/many/")).length, 0, "no unsaved documents left behind");
    },
  ],
  [
    "keeps a BOM and leaves a file that is not UTF-8 alone",
    async (ws) => {
      const bom = vscode.Uri.joinPath(ws, "notes/bom.md");
      const latin1 = vscode.Uri.joinPath(ws, "notes/latin1.md");
      await vscode.workspace.fs.writeFile(bom, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("---\na: 1\n---\n")]));
      const latin1Bytes = new Uint8Array([...new TextEncoder().encode("---\nname: M"), 0xfc, ...new TextEncoder().encode("ller\n---\n")]);
      await vscode.workspace.fs.writeFile(latin1, latin1Bytes);
      const outcome = await applyPropertyEdits([bom, latin1], [{ kind: "set", key: "b", value: 2 }]);
      assert.equal(outcome.changed, 1);
      assert.match(outcome.failures[0]!, /latin1.md: not UTF-8/);
      const bomBytes = await vscode.workspace.fs.readFile(bom);
      assert.deepEqual([...bomBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM kept");
      assert.equal(new TextDecoder().decode(bomBytes), "---\na: 1\nb: 2\n---\n");
      assert.deepEqual([...(await vscode.workspace.fs.readFile(latin1))], [...latin1Bytes], "untouched, byte for byte");
    },
  ],
  [
    "does not save a file that held unsaved work before the edit",
    async (ws) => {
      const gamma = vscode.Uri.joinPath(ws, "projects/gamma.md");
      const doc = await vscode.workspace.openTextDocument(gamma);
      const pending = new vscode.WorkspaceEdit();
      pending.insert(gamma, new vscode.Position(doc.lineCount - 1, 0), "Unsaved line.\n");
      await vscode.workspace.applyEdit(pending);
      assert.ok(doc.isDirty);

      await applyPropertyEdits([gamma], [{ kind: "set", key: "status", value: "blocked" }]);
      assert.ok(doc.isDirty, "still unsaved");
      assert.ok(doc.getText().includes("status: blocked") && doc.getText().includes("Unsaved line."));
      assert.ok((await read(gamma)).includes("status: in-progress"), "disk unchanged");
      assert.ok(doc.getText().includes('title: "Gamma"   # working title'));
    },
  ],
  [
    "opens a .base file in the custom editor",
    async (ws) => {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.joinPath(ws, "everything.base"));
      await waitFor("the custom editor tab", () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === "bases.editor";
      });
    },
  ],
];

const log = vscode.window.createOutputChannel("Bases tests", { log: true });
const storage = vscode.Uri.file(`${process.env.TMPDIR ?? "/tmp"}/bases-it-storage-${process.pid}`);

async function freshIndex(): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex(storage, log);
  await index.whenScanned();
  return index;
}

const cacheTests: [string, (ws: vscode.Uri) => Promise<void>][] = [
  [
    "a second start reads no file again, but notices a changed and a deleted one",
    async (ws) => {
      const first = await freshIndex();
      await first.saveCache();
      first.dispose();

      // Only files with unsaved changes in an editor are read: their text is not what was cached.
      const unsaved = vscode.workspace.textDocuments.filter((d) => d.isDirty && /\.(md|ya?ml)$/.test(d.uri.path)).length;
      const second = await freshIndex();
      assert.equal(second.lastScan?.read, unsaved, JSON.stringify(second.lastScan));
      assert.ok(second.lastScan!.reused >= 7);
      second.dispose();

      const meeting = vscode.Uri.joinPath(ws, "notes/meeting.md");
      await vscode.workspace.fs.writeFile(meeting, new TextEncoder().encode("---\ntype: retro\n---\n"));
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(ws, "deploy/worker.yml"));
      const third = await freshIndex();
      assert.deepEqual({ read: third.lastScan?.read, removed: third.lastScan?.removed }, { read: unsaved + 1, removed: 1 });
      assert.equal(third.get(meeting)?.properties.type, "retro");
      third.dispose();
    },
  ],
  [
    "reads links from the project's SQLite database, and again when it changes",
    async (ws) => {
      const index = new WorkspaceIndex(undefined, log);
      await index.whenScanned();
      const ext = vscode.extensions.getExtension("dom8509.vscode-bases")!.extensionUri;
      const SQL = await initSqlJs({ locateFile: (f) => vscode.Uri.joinPath(ext, "dist", f).fsPath });
      const dbFile = vscode.Uri.joinPath(ws, "db/project.sqlite");
      const write = async (rows: string) => {
        const db = new SQL.Database();
        db.run(`CREATE TABLE refs (from_file TEXT, to_file TEXT, kind TEXT); INSERT INTO refs VALUES ${rows};`);
        await vscode.workspace.fs.writeFile(dbFile, db.export());
        db.close();
      };
      await write("('lastenheft/REQ-002.md', 'REQ-001', 'refines'), ('../notes/meeting.md', 'lastenheft/REQ-001.md', 'mentions')");
      const config = vscode.workspace.getConfiguration("bases");
      await config.update("links.query", "SELECT from_file AS source, to_file AS target, kind AS type FROM refs", vscode.ConfigurationTarget.Workspace);
      await config.update("links.database", "db/project.sqlite", vscode.ConfigurationTarget.Workspace);
      const links = new LinkSource(ext, index, log);
      try {
        const backlinks = () => links.links()?.backlinksOf("lastenheft/REQ-001.md") ?? [];
        await waitFor("links read", () => backlinks().length === 2);
        assert.deepEqual(backlinks(), ["lastenheft/REQ-002.md", "notes/meeting.md"]);
        const base = parseBase(`views:\n  - type: table\n    filters: 'file.backlinks("refines").length > 0'\n    order: [file.name, file.backlinks]\n`);
        const view = computeView(base, index.all(), { viewIndex: 0, links: links.links() });
        assert.deepEqual(view.errors, []);
        assert.deepEqual(view.rows.map((r) => r.path), ["lastenheft/REQ-001.md"]);

        await write("('lastenheft/REQ-003.md', 'REQ-001.md', 'refines')");
        await waitFor("links read again", () => backlinks().length === 1);
        assert.deepEqual(backlinks(), ["lastenheft/REQ-003.md"]);
      } finally {
        links.dispose();
        index.dispose();
        await config.update("links.database", undefined, vscode.ConfigurationTarget.Workspace);
        await config.update("links.query", undefined, vscode.ConfigurationTarget.Workspace);
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(ws, "db"), { recursive: true });
      }
    },
  ],
];

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0]!.uri;
  // No Refactor Preview: nobody is there to confirm it.
  await vscode.workspace.getConfiguration("bases").update("confirmBulkEdits", false, vscode.ConfigurationTarget.Global);
  const index = new WorkspaceIndex(undefined, log);
  await index.whenScanned();

  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test(ws, index);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n    ${(e as Error).stack ?? e}`);
    }
  }
  index.dispose();
  for (const [name, test] of cacheTests) {
    try {
      await test(ws);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n    ${(e as Error).stack ?? e}`);
    }
  }
  await vscode.workspace.fs.delete(storage, { recursive: true }).then(undefined, () => undefined);
  if (failed > 0) throw new Error(`${failed} integration test(s) failed`);
}
