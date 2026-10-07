// Messages between the extension host and the base webview.

import type { SortSpec, ViewResult } from "./core/base";
import type { BaseOp } from "./core/baseEdit";
import type { PropertyEdit } from "./core/writer";

/** A value as typed into the UI; the host reads it as YAML. */
export type UiEdit =
  | { kind: "set"; key: string; input: string }
  | { kind: "delete"; key: string }
  | { kind: "rename"; from: string; to: string };

/** What the person is looking at: not part of the base file. */
export interface UiState {
  viewIndex: number;
  page: number;
  pageSize: number;
  query: string;
}

export type ToWebview =
  | { type: "render"; result: ViewResult }
  | { type: "error"; message: string }
  | { type: "notice"; message: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "ui"; state: Partial<UiState> }
  /** Changes to the .base file: views, filters, columns, sort, formulas. */
  | { type: "baseOps"; ops: BaseOp[] }
  | { type: "open"; uri: string }
  | { type: "edit"; uris: string[]; edits: UiEdit[] }
  | { type: "openAsText" };

export type { BaseOp, PropertyEdit, SortSpec, ViewResult };
