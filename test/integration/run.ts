// Runs the integration suite in a downloaded VS Code, against a scratch copy
// of the sample workspace so the suite's edits never touch the repo.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(__dirname, "../..");
const workspace = mkdtempSync(join(tmpdir(), "bases-it-"));
cpSync(join(root, "sample"), workspace, { recursive: true });

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, "dist/test/suite.js"),
  launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust"],
})
  .then(
    () => 0,
    (e) => {
      console.error(e);
      return 1;
    },
  )
  .then((code) => {
    rmSync(workspace, { recursive: true, force: true });
    process.exit(code);
  });
