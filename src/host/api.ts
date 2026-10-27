// What Bases offers other extensions: the notes of the workspace as the index
// holds them, with the links between them. Another extension gets it with
//
//   const bases = vscode.extensions.getExtension("dom8509.vscode-bases");
//   const api: BasesApi = await bases.activate();
//
// so one index and one cache serve both. The shape only grows: a change that
// would break a caller gets a new `version`.

import * as vscode from "vscode";
import { makeNoteLinkResolver } from "../core/links";
import type { SourceKind } from "../core/record";
import type { WorkspaceIndex } from "./indexer";
import type { LinkSource } from "./links";

export interface BasesLink {
  /** Workspace-relative path of the file the link points to. */
  target: string;
  /** The link type from the link database; "" for a link in the text. */
  type: string;
}

export interface BasesFile {
  uri: string;
  /** Workspace-relative path, e.g. "notes/idea.md". */
  path: string;
  /** File name without its extension. */
  basename: string;
  folder: string;
  kind: SourceKind;
  mtime: number;
  /** The frontmatter of a Markdown file, the top-level keys of a YAML file. */
  properties: Record<string, unknown>;
  tags: string[];
  /** Links to other files of the index: from the text, then from the link database. */
  links: BasesLink[];
}

export interface BasesApi {
  readonly version: 1;
  /** Resolves as soon as there is something to show (the cached files, or the first scan). */
  ready(): Promise<void>;
  /** Resolves when every file was checked against the disk. */
  scanned(): Promise<void>;
  /** Every file of the index, now. */
  files(): BasesFile[];
  /** Fires, debounced, after files or links changed. */
  readonly onDidChange: vscode.Event<void>;
}

export function createApi(index: WorkspaceIndex, links: LinkSource): BasesApi {
  return {
    version: 1,
    ready: () => index.ensureReady(),
    scanned: () => index.whenScanned(),
    onDidChange: (listener, thisArgs, disposables) => {
      const subs = [index.onDidChange(listener, thisArgs), links.onDidChange(listener, thisArgs)];
      const sub = vscode.Disposable.from(...subs);
      disposables?.push(sub);
      return sub;
    },
    files: () => {
      const records = [...index.all()];
      const resolve = makeNoteLinkResolver(records.map((r) => r.file.path));
      const graph = links.links();
      return records.map((r) => {
        const out: BasesLink[] = [];
        const seen = new Set<string>();
        const add = (target: string | undefined, type: string) => {
          if (!target || target === r.file.path || seen.has(`${type}\n${target}`)) return;
          seen.add(`${type}\n${target}`);
          out.push({ target, type });
        };
        for (const raw of r.links ?? []) add(resolve(r.file.folder, raw), "");
        for (const l of graph?.outgoing(r.file.path) ?? []) add(l.target, l.type);
        return {
          uri: r.uri,
          path: r.file.path,
          basename: r.file.basename,
          folder: r.file.folder,
          kind: r.kind,
          mtime: r.file.mtime,
          properties: r.properties,
          tags: r.tags,
          links: out,
        };
      });
    },
  };
}
