// Runs inside VS Code: indexes a generated workspace twice, without and with
// the cache, and reports how long each takes. `npm run test:perf`.

import * as vscode from "vscode";
import { computeView, parseBase } from "../../src/core/base";
import { WorkspaceIndex } from "../../src/host/indexer";

export async function run(): Promise<void> {
  const log = vscode.window.createOutputChannel("Bases perf", { log: true });
  const storage = vscode.Uri.file(`${process.env.TMPDIR ?? "/tmp"}/bases-perf-storage-${process.pid}`);
  const time = async <T>(fn: () => Promise<T> | T): Promise<[T, number]> => {
    const started = performance.now();
    const value = await fn();
    return [value, Math.round(performance.now() - started)];
  };

  const [cold, coldMs] = await time(async () => {
    const index = new WorkspaceIndex(storage, log);
    await index.whenScanned();
    return index;
  });
  const [, saveMs] = await time(() => cold.saveCache());
  const files = [...cold.all()].length;
  cold.dispose();

  // With a cache, the first render can happen as soon as the cache is loaded.
  const warm = new WorkspaceIndex(storage, log);
  const [, firstShowMs] = await time(() => warm.ensureReady());
  const shown = [...warm.all()].length;
  const [, checkMs] = await time(() => warm.whenScanned());

  const base = parseBase('filters: status != "done"\nviews:\n  - type: table\n    name: x\n    order: [file.name, status, priority, tags]\n    sort:\n      - property: priority\n        direction: DESC\n');
  const [view, viewMs] = await time(() => computeView(base, warm.all(), { viewIndex: 0 }));
  warm.dispose();
  await vscode.workspace.fs.delete(storage, { recursive: true }).then(undefined, () => undefined);

  console.log(`  files indexed:                       ${files}`);
  console.log(`  cold start (no cache), full scan:    ${coldMs} ms   ${JSON.stringify(cold.lastScan)}`);
  console.log(`  saving the cache:                    ${saveMs} ms`);
  console.log(`  warm start, rows shown after:        ${firstShowMs} ms   (${shown} records from cache)`);
  console.log(`  warm start, check against disk:      ${checkMs} ms more   ${JSON.stringify(warm.lastScan)}`);
  console.log(`  computing a view (${view.matchCount} matches):    ${viewMs} ms`);
}
