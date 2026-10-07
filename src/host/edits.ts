// Turns property edits on many files into one WorkspaceEdit: one undo step,
// and the Refactor Preview first when it touches more than one file.

import * as vscode from "vscode";
import { applyEdits, type PropertyEdit } from "../core/writer";

function describe(edits: PropertyEdit[]): string {
  return edits
    .map((e) => (e.kind === "set" ? `Set ${e.key}` : e.kind === "delete" ? `Remove ${e.key}` : `Rename ${e.from} → ${e.to}`))
    .join(", ");
}

export interface EditOutcome {
  applied: boolean;
  changed: number;
  failures: string[];
}

export async function applyPropertyEdits(uris: vscode.Uri[], edits: PropertyEdit[]): Promise<EditOutcome> {
  const label = describe(edits);
  const confirm = uris.length > 1 && vscode.workspace.getConfiguration("bases").get<boolean>("confirmBulkEdits", true);
  const metadata: vscode.WorkspaceEditEntryMetadata = { label, needsConfirmation: confirm };
  const edit = new vscode.WorkspaceEdit();
  const failures: string[] = [];
  const touched: { doc: vscode.TextDocument; wasDirty: boolean }[] = [];
  let changed = 0;

  for (const uri of uris) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const ext = uri.path.slice(uri.path.lastIndexOf(".") + 1);
      const change = applyEdits(doc.getText(), ext, edits);
      if (!change) continue;
      edit.replace(uri, new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.text, metadata);
      touched.push({ doc, wasDirty: doc.isDirty });
      changed++;
    } catch (e) {
      failures.push(`${vscode.workspace.asRelativePath(uri)}: ${(e as Error).message}`);
    }
  }

  if (changed === 0) return { applied: false, changed, failures };
  const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  if (applied) {
    // Save what the edit changed, but leave a file alone that already held
    // unsaved work: that is still the person's to save or discard.
    await Promise.all(touched.filter((t) => !t.wasDirty && t.doc.isDirty).map((t) => t.doc.save()));
  }
  return { applied, changed, failures };
}
