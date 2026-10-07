// Messages between the extension host and the base webview.

import type { SortSpec, ViewResult } from "./core/base";
import type { PropertyEdit } from "./core/writer";

/** A value as typed into the UI; the host reads it as YAML. */
export type UiEdit =
  | { kind: "set"; key: string; input: string }
  | { kind: "delete"; key: string }
  | { kind: "rename"; from: string; to: string };

export type ToWebview =
  | { type: "render"; result: ViewResult }
  | { type: "error"; message: string }
  | { type: "notice"; message: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "selectView"; index: number }
  | { type: "sort"; sort: SortSpec[] }
  | { type: "open"; uri: string }
  | { type: "edit"; uris: string[]; edits: UiEdit[] }
  | { type: "openAsText" };

export type { PropertyEdit, SortSpec, ViewResult };
