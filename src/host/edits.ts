// Applies property edits to files.
//
// Edits run one at a time through a queue, so each is computed on the text
// the one before left. A file no editor holds is read, changed and written
// directly, after a stat confirms it is still what was read. A file an editor
// holds is changed through a WorkspaceEdit computed and applied in the same
// tick, then checked to hold exactly what was computed, and saved unless it
// held unsaved work before. An edit to more than one file asks first; the
// diff it can show is a dry run, and what is applied is computed again after
// the answer.

import * as vscode from "vscode";
import { applyEdits, lineDiff, type PropertyEdit, type TextChange } from "../core/writer";
import { disk } from "./disk";

const BATCH = 64;
const PREVIEW_SCHEME = "bases-preview";

export interface EditOutcome {
  /** False when nothing was written: cancelled, nothing to change, or rejected. */
  applied: boolean;
  changed: number;
  failures: string[];
  /** Files something else changed while the edit was applied; check them. */
  concurrent: string[];
}

function describe(edits: PropertyEdit[]): string {
  return edits
    .map((e) => (e.kind === "set" ? `Set "${e.key}" to ${JSON.stringify(e.value)}` : e.kind === "delete" ? `Remove "${e.key}"` : `Rename "${e.from}" to "${e.to}"`))
    .join(", ");
}

const rel = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri);

// --- the queue ------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

// --- preview documents ------------------------------------------------------------

const previews = new Map<string, string>();
const previewChanged = new vscode.EventEmitter<vscode.Uri>();

/** Serves the read-only diff documents the confirmation shows. */
export function registerPreviewProvider(): vscode.Disposable {
  return vscode.Disposable.from(
    previewChanged,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      onDidChange: previewChanged.event,
      provideTextDocumentContent: (uri) => previews.get(uri.path) ?? "",
    }),
  );
}

const PREVIEW_FILES = 500;

async function showPreview(label: string, diffs: { uri: vscode.Uri; lines: string[] }[]): Promise<void> {
  const shown = diffs.slice(0, PREVIEW_FILES);
  const text = [
    `# ${label}`,
    `# ${diffs.length} file(s) change${diffs.length > PREVIEW_FILES ? `; the first ${PREVIEW_FILES} are shown` : ""}`,
    "",
    ...shown.flatMap((d) => [`--- ${rel(d.uri)}`, `+++ ${rel(d.uri)}`, ...d.lines, ""]),
  ].join("\n");
  const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: "/Bases changes.diff" });
  previews.set(uri.path, text);
  previewChanged.fire(uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

// --- computing --------------------------------------------------------------------

interface Planned {
  doc: vscode.TextDocument;
  version: number;
  before: string;
  change: TextChange;
}

async function openAll(uris: vscode.Uri[], failures: string[]): Promise<vscode.TextDocument[]> {
  const docs: vscode.TextDocument[] = [];
  for (let i = 0; i < uris.length; i += BATCH) {
    const batch = await Promise.all(
      uris.slice(i, i + BATCH).map((u) =>
        vscode.workspace.openTextDocument(u).then(undefined, (e: Error) => {
          failures.push(`${rel(u)}: ${e.message}`);
          return undefined;
        }),
      ),
    );
    for (const d of batch) if (d) docs.push(d);
  }
  return docs;
}

/** Synchronous on purpose: the plan must not go stale before it is applied. */
function plan(docs: vscode.TextDocument[], edits: PropertyEdit[], failures: string[]): Planned[] {
  const planned: Planned[] = [];
  for (const doc of docs) {
    try {
      const ext = doc.uri.path.slice(doc.uri.path.lastIndexOf(".") + 1);
      const before = doc.getText();
      const change = applyEdits(before, ext, edits);
      if (change) planned.push({ doc, version: doc.version, before, change });
    } catch (e) {
      failures.push(`${rel(doc.uri)}: ${(e as Error).message}`);
    }
  }
  return planned;
}

/**
 * The documents as they are now. VS Code keeps only a few documents that no
 * editor shows; the rest it closes again, and opens anew to apply an edit.
 * A document from before the edit may be one of those closed ones: it no
 * longer changes, and saving it does nothing.
 */
async function live(planned: Planned[]): Promise<Map<string, vscode.TextDocument>> {
  const docs = await openAll(planned.map((p) => p.doc.uri), []);
  return new Map(docs.map((d) => [d.uri.toString(), d]));
}

/** The files that do not hold what was computed, waiting briefly for documents that lag behind. */
async function mismatches(planned: Planned[]): Promise<Planned[]> {
  let wrong = planned;
  for (let attempt = 0; attempt < 10 && wrong.length > 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200));
    const docs = await live(wrong);
    wrong = wrong.filter((p) => docs.get(p.doc.uri.toString())?.getText() !== result(p));
  }
  return wrong;
}

const result = (p: Planned) => p.before.slice(0, p.change.start) + p.change.text + p.before.slice(p.change.end);

// --- applying ---------------------------------------------------------------------

/**
 * Applies the edits to the files. With `confirm`, an edit to more than one
 * file asks first. Edits run one at a time.
 */
export function applyPropertyEdits(uris: vscode.Uri[], edits: PropertyEdit[], opts: { confirm?: boolean } = {}): Promise<EditOutcome> {
  return enqueue(() => run(uris, edits, opts.confirm === true && uris.length > 1));
}

// --- files no editor holds: read and written directly -----------------------------

// Strict, and keeping a BOM, so what is written back is byte for byte what was read plus the change.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === uri.toString());
}

/** A file's current text: an editor's if one holds it, else the disk's; undefined when it is not UTF-8. */
async function currentText(uri: vscode.Uri): Promise<string | undefined> {
  const doc = openDocument(uri);
  if (doc) return doc.getText();
  try {
    return utf8.decode(await disk.read(uri));
  } catch {
    return undefined;
  }
}

interface DiskResult {
  changed: number;
  /** Files an editor opened meanwhile: they are edited through their document after all. */
  viaDocuments: vscode.Uri[];
}

/**
 * Reads, changes and writes each file. Right before writing, a stat checks
 * that the file is still what was read; if not, the change is computed again.
 * No formatter runs: the file gets exactly the computed change.
 */
async function editOnDisk(uris: vscode.Uri[], edits: PropertyEdit[], failures: string[], report: (n: number) => void): Promise<DiskResult> {
  const out: DiskResult = { changed: 0, viaDocuments: [] };
  const one = async (uri: vscode.Uri) => {
    const ext = uri.path.slice(uri.path.lastIndexOf(".") + 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const stat = await disk.stat(uri);
      let text: string;
      try {
        text = utf8.decode(await disk.read(uri));
      } catch {
        // Writing it back as UTF-8 would garble it; in an editor the person picks its encoding.
        failures.push(`${rel(uri)}: not UTF-8; open it in an editor to edit it`);
        return;
      }
      const change = applyEdits(text, ext, edits);
      if (!change) return;
      const next = text.slice(0, change.start) + change.text + text.slice(change.end);
      const now = await disk.stat(uri);
      if (now.mtime !== stat.mtime || now.size !== stat.size) continue;
      if (openDocument(uri)) {
        out.viaDocuments.push(uri);
        return;
      }
      await disk.write(uri, encoder.encode(next));
      out.changed++;
      return;
    }
    failures.push(`${rel(uri)}: kept changing while it was edited; not changed`);
  };
  for (let i = 0; i < uris.length; i += BATCH) {
    await Promise.all(
      uris.slice(i, i + BATCH).map((u) => one(u).catch((e: Error) => failures.push(`${rel(u)}: ${e.message}`))),
    );
    report(Math.min(BATCH, uris.length - i));
  }
  return out;
}

// --- files an editor holds: through VS Code documents -------------------------------

interface DocumentResult {
  changed: number;
  concurrent: string[];
}

/**
 * Applies the change as a WorkspaceEdit, so an open editor keeps its state and
 * undo. Computed and applied without an await in between; once more if VS Code
 * rejects it because a file changed after all.
 */
async function editDocuments(uris: vscode.Uri[], edits: PropertyEdit[], label: string, failures: string[]): Promise<DocumentResult> {
  if (uris.length === 0) return { changed: 0, concurrent: [] };
  const docs = await openAll(uris, failures);
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptFailures: string[] = [];
    const planned = plan(docs, edits, attemptFailures);
    if (planned.length === 0) {
      failures.push(...attemptFailures);
      return { changed: 0, concurrent: [] };
    }
    const edit = new vscode.WorkspaceEdit();
    for (const p of planned) edit.replace(p.doc.uri, new vscode.Range(p.doc.positionAt(p.change.start), p.doc.positionAt(p.change.end)), p.change.text, { label, needsConfirmation: false });
    const dirtyBefore = new Set(planned.filter((p) => p.doc.isDirty).map((p) => p.doc.uri.toString()));
    if (!(await vscode.workspace.applyEdit(edit))) continue;

    failures.push(...attemptFailures);
    // Each file must now hold exactly what was computed; anything else means
    // something changed it at the same moment. Checked before saving, which
    // may run formatters.
    const concurrent = (await mismatches(planned)).map((p) => rel(p.doc.uri));
    // Save through the documents as they are now; a file that already held
    // unsaved work stays the person's to save.
    const current = await live(planned);
    const toSave = planned.map((p) => current.get(p.doc.uri.toString())).filter((d): d is vscode.TextDocument => d !== undefined && d.isDirty && !dirtyBefore.has(d.uri.toString()));
    for (let i = 0; i < toSave.length; i += BATCH) {
      const saved = await Promise.all(toSave.slice(i, i + BATCH).map((d) => d.save()));
      saved.forEach((ok, k) => ok || failures.push(`${rel(toSave[i + k]!.uri)}: changed but could not be saved`));
    }
    return { changed: planned.length, concurrent };
  }
  failures.push(`${uris.length} open file(s) kept changing while the edit was applied; they were not changed. Try again.`);
  return { changed: 0, concurrent: [] };
}

// --- the edit -------------------------------------------------------------------

async function confirmEdit(uris: vscode.Uri[], edits: PropertyEdit[], label: string): Promise<boolean> {
  // A dry run for the question and the diff; what is applied is computed again after the answer.
  const changes: { uri: vscode.Uri; lines: string[] }[] = [];
  let unchanged = 0;
  let broken = 0;
  for (let i = 0; i < uris.length; i += BATCH) {
    await Promise.all(
      uris.slice(i, i + BATCH).map(async (uri) => {
        try {
          const text = (await currentText(uri)) ?? (await vscode.workspace.openTextDocument(uri)).getText();
          const change = applyEdits(text, uri.path.slice(uri.path.lastIndexOf(".") + 1), edits);
          if (!change) unchanged++;
          else changes.push({ uri, lines: lineDiff(text, text.slice(0, change.start) + change.text + text.slice(change.end)) });
        } catch {
          broken++;
        }
      }),
    );
  }
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(broken > 0 ? `None of the ${uris.length} files can take this edit.` : `All ${uris.length} files already have this value.`);
    return false;
  }
  changes.sort((a, b) => rel(a.uri).localeCompare(rel(b.uri)));
  const detail = [
    `${changes.length} file(s) will change.`,
    unchanged > 0 ? `${unchanged} already have this value.` : "",
    broken > 0 ? `${broken} cannot be edited and stay as they are.` : "",
  ].filter(Boolean).join(" ");
  for (;;) {
    const answer = await vscode.window.showInformationMessage(`${label} in ${changes.length} file(s)?`, { modal: true, detail }, "Apply", "Show Changes");
    if (answer === "Apply") return true;
    if (answer !== "Show Changes") return false;
    await showPreview(label, changes);
  }
}

async function run(uris: vscode.Uri[], edits: PropertyEdit[], confirm: boolean): Promise<EditOutcome> {
  const label = describe(edits);
  const failures: string[] = [];
  if (confirm && !(await confirmEdit(uris, edits, label))) return { applied: false, changed: 0, failures, concurrent: [] };

  const work = async (report: (increment: number) => void): Promise<EditOutcome> => {
    // Files an editor holds go through VS Code documents; the rest are read and written directly.
    const inEditor = uris.filter((u) => openDocument(u));
    const onDisk = uris.filter((u) => !openDocument(u));
    const disk = await editOnDisk(onDisk, edits, failures, (n) => report((90 * n) / Math.max(uris.length, 1)));
    const docs = await editDocuments([...inEditor, ...disk.viaDocuments], edits, label, failures);
    const changed = disk.changed + docs.changed;
    return { applied: changed > 0, changed, failures, concurrent: docs.concurrent };
  };

  if (uris.length <= 50) return work(() => undefined);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Bases: ${label} in ${uris.length} files` },
    (progress) => work((increment) => progress.report({ increment })),
  );
}
