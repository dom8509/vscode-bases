// Runs the integration suite in a downloaded VS Code, against a scratch copy
// of the sample workspace so the suite's edits never touch the repo.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(__dirname, "../..");
const workspace = mkdtempSync(join(tmpdir(), "bases-it-"));
// --perf [count]: a generated workspace of many notes, and the perf suite.
const perf = process.argv.includes("--perf");
if (perf) {
  const count = Number(process.argv[process.argv.indexOf("--perf") + 1]) || 20000;
  const body = "Lorem ipsum dolor sit amet. ".repeat(200);
  for (let d = 0; d < count / 500; d++) {
    mkdirSync(join(workspace, `notes/d${d}`), { recursive: true });
    for (let i = d * 500; i < Math.min((d + 1) * 500, count); i++) {
      writeFileSync(join(workspace, `notes/d${d}/n${i}.md`), `---\ntitle: Note ${i}\nstatus: ${["open", "done", "review"][i % 3]}\npriority: ${i % 5}\ntags: [project, t${i % 50}]\n---\n# Note ${i}\n\n${body}\n`);
    }
  }
} else {
  cpSync(join(root, "sample"), workspace, { recursive: true });
}

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, perf ? "dist/test/perf.js" : "dist/test/suite.js"),
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
