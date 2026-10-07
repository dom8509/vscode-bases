// File access for many files at once. Local files go through Node directly:
// each workspace.fs call costs a round trip, which adds up to seconds with
// thousands of files. Other schemes (remote, virtual) use workspace.fs.

import { promises as nodeFs } from "node:fs";
import * as vscode from "vscode";

export interface DiskStat {
  mtime: number;
  ctime: number;
  size: number;
}

export const disk = {
  stat: async (u: vscode.Uri): Promise<DiskStat> => {
    if (u.scheme !== "file") return vscode.workspace.fs.stat(u);
    const s = await nodeFs.stat(u.fsPath);
    return { mtime: Math.floor(s.mtimeMs), ctime: Math.floor(s.birthtimeMs || s.ctimeMs), size: s.size };
  },
  read: (u: vscode.Uri): Promise<Uint8Array> => (u.scheme === "file" ? nodeFs.readFile(u.fsPath) : Promise.resolve(vscode.workspace.fs.readFile(u))),
  write: (u: vscode.Uri, bytes: Uint8Array): Promise<void> => (u.scheme === "file" ? nodeFs.writeFile(u.fsPath, bytes) : Promise.resolve(vscode.workspace.fs.writeFile(u, bytes))),
};
