import { copyFileSync, mkdirSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  },
  {
    entryPoints: ["webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
  },
];

if (tests) {
  builds.push(
    { entryPoints: ["test/integration/run.ts"], outfile: "dist/test/run.js", platform: "node", format: "cjs", external: ["@vscode/test-electron"] },
    { entryPoints: ["test/integration/suite.ts"], outfile: "dist/test/suite.js", platform: "node", format: "cjs", external: ["vscode"] },
    { entryPoints: ["test/integration/perf.ts"], outfile: "dist/test/perf.js", platform: "node", format: "cjs", external: ["vscode"] },
  );
}

// SQLite as WebAssembly, for the link database: sql.js loads it next to the extension.
mkdirSync("dist", { recursive: true });
copyFileSync("node_modules/sql.js/dist/sql-wasm.wasm", "dist/sql-wasm.wasm");

for (const options of builds) {
  const ctx = await esbuild.context({
    ...options,
    bundle: true,
    sourcemap: true,
    target: "es2022",
    logLevel: "info",
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
