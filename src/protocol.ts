// Messages between the extension host and the base webview.

import type { SortSpec, ViewResult } from "./core/base";
import type { BaseOp } from "./core/baseEdit";
import type { PropertyEdit } from "./core/writer";

/** An edit from the UI: `set` carries text the host reads as YAML, `setValue` a typed value from a cell editor. */
export type UiEdit =
  | { kind: "set"; key: string; input: string }
  | { kind: "setValue"; key: string; value: unknown }
  | { kind: "delete"; key: string }
  | { kind: "rename"; from: string; to: string };

/** What the person is looking at: not part of the base file. */
export interface UiState {
  viewIndex: number;
  page: number;
  pageSize: number;
  query: string;
}

/** How far indexing is. `checking` is a scan over records already shown from the cache. */
export interface IndexProgress {
  done: number;
  total: number;
  checking: boolean;
}

/** Which files an edit applies to: a list, or every file the view matches except some. */
export type EditTarget = { uris: string[] } | { allMatching: true; except: string[] };

export type ToWebview =
  | { type: "render"; result: ViewResult; indexing?: IndexProgress }
  | { type: "error"; message: string }
  | { type: "notice"; message: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "ui"; state: Partial<UiState> }
  /** Changes to the .base file: views, filters, columns, sort, formulas. */
  | { type: "baseOps"; ops: BaseOp[] }
  | { type: "open"; uri: string }
  /** `confirmed`: the person already agreed in the table, so the host does not ask again. */
  | { type: "edit"; target: EditTarget; edits: UiEdit[]; confirmed?: boolean }
  /** Every result of the view as it is now (all pages), to the clipboard or a CSV file. */
  | { type: "export"; to: "clipboard" | "csv" | "markdown" | "html" }
  /** "+ New": a note with the values the view's filters ask for. */
  | { type: "newNote" };

export type { BaseOp, PropertyEdit, SortSpec, ViewResult };
