// The table UI of a base. It holds no data of its own: every render comes
// from the host, and every change goes back to the host as a message.

import type { FromWebview, SortSpec, ToWebview, UiEdit, ViewResult } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
const send = (msg: FromWebview) => vscode.postMessage(msg);

type Row = ViewResult["rows"][number];

let result: ViewResult | undefined;
let error: string | undefined;
let notice: string | undefined;
let noticeTimer: number | undefined;
let search = "";
const selected = new Set<string>();
let lastClicked: string | undefined;
// The bulk-edit inputs survive re-renders, so one edit can follow another.
const bulk = { key: "", value: "", target: "" };

const app = document.getElementById("app")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** How a value reads in a cell. */
function display(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(display).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** How a value reads in the edit box: YAML, so it round-trips through the host's parser. */
function editable(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" && /[,[\]{}:#]/.test(x) ? JSON.stringify(x) : display(x))).join(", ")}]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function visibleRows(): Row[] {
  if (!result) return [];
  const q = search.trim().toLowerCase();
  if (!q) return result.rows;
  return result.rows.filter((r) => r.path.toLowerCase().includes(q) || Object.values(r.cells).some((v) => display(v).toLowerCase().includes(q)));
}

function edit(uris: string[], edits: UiEdit[]): void {
  send({ type: "edit", uris, edits });
}

function nextSort(column: string): SortSpec[] {
  const current = result?.sort[0];
  if (!current || current.property !== column) return [{ property: column, direction: "ASC" }];
  if (current.direction === "ASC") return [{ property: column, direction: "DESC" }];
  return [];
}

function toolbar(): HTMLElement {
  const bar = el("div", { class: "toolbar" });
  const tabs = el("div", { class: "tabs" });
  result?.views.forEach((v, i) => {
    const b = el("button", { class: i === result!.viewIndex ? "tab active" : "tab", title: v.type }, v.name);
    b.onclick = () => send({ type: "selectView", index: i });
    tabs.append(b);
  });
  const input = el("input", { type: "search", placeholder: "Search rows…", value: search, class: "search" });
  input.oninput = () => {
    search = input.value;
    renderTable();
  };
  const count = el("span", { class: "count", id: "count" });
  const asText = el("button", { class: "secondary", title: "Edit the .base file as YAML" }, "Edit as YAML");
  asText.onclick = () => send({ type: "openAsText" });
  bar.append(tabs, input, count, asText);
  return bar;
}

function bulkBar(): HTMLElement {
  const bar = el("div", { class: "bulk", id: "bulk" });
  const list = el("datalist", { id: "props" }, ...(result?.propertyNames ?? []).map((p) => el("option", { value: p })));
  const key = el("input", { placeholder: "property", list: "props", class: "key", value: bulk.key });
  const value = el("input", { placeholder: "value (YAML: 3, true, [a, b])", class: "value", value: bulk.value });
  const target = el("input", { placeholder: "new name", class: "key", value: bulk.target });
  key.oninput = () => (bulk.key = key.value);
  value.oninput = () => (bulk.value = value.value);
  target.oninput = () => (bulk.target = target.value);
  const uris = () => [...selected];
  const needKey = () => {
    if (!key.value.trim()) {
      key.focus();
      return false;
    }
    return true;
  };

  const set = el("button", {}, "Set");
  set.onclick = () => needKey() && edit(uris(), [{ kind: "set", key: key.value.trim(), input: value.value }]);
  const remove = el("button", { class: "secondary" }, "Remove");
  remove.onclick = () => needKey() && edit(uris(), [{ kind: "delete", key: key.value.trim() }]);
  const rename = el("button", { class: "secondary" }, "Rename");
  rename.onclick = () => needKey() && target.value.trim() && edit(uris(), [{ kind: "rename", from: key.value.trim(), to: target.value.trim() }]);
  const clear = el("button", { class: "link" }, "Clear selection");
  clear.onclick = () => {
    selected.clear();
    renderTable();
  };

  bar.append(el("span", { class: "selection", id: "selection" }), list, key, value, set, remove, el("span", { class: "sep" }, "→"), target, rename, clear);
  return bar;
}

function startEdit(td: HTMLTableCellElement, row: Row, column: string): void {
  if (td.querySelector("input")) return;
  const original = editable(row.cells[column]);
  const input = el("input", { class: "cell-input", value: original });
  td.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit && input.value !== original) {
      edit([row.uri], [input.value.trim() === "" ? { kind: "delete", key: column } : { kind: "set", key: column, input: input.value }]);
    }
    td.textContent = display(row.cells[column]);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

function toggle(uri: string, rows: Row[], range: boolean): void {
  if (range && lastClicked) {
    const a = rows.findIndex((r) => r.uri === lastClicked);
    const b = rows.findIndex((r) => r.uri === uri);
    if (a >= 0 && b >= 0) {
      const on = !selected.has(uri);
      for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? selected.add(r.uri) : selected.delete(r.uri);
      lastClicked = uri;
      return;
    }
  }
  selected.has(uri) ? selected.delete(uri) : selected.add(uri);
  lastClicked = uri;
}

function renderTable(): void {
  const host = document.getElementById("table-host");
  if (!host || !result) return;
  const rows = visibleRows();
  const known = new Set(result.rows.map((r) => r.uri));
  for (const u of [...selected]) if (!known.has(u)) selected.delete(u);

  const sort = result.sort[0];
  const all = el("input", { type: "checkbox", title: "Select all shown rows" });
  all.checked = rows.length > 0 && rows.every((r) => selected.has(r.uri));
  all.onchange = () => {
    for (const r of rows) all.checked ? selected.add(r.uri) : selected.delete(r.uri);
    renderTable();
  };
  const head = el("tr", {}, el("th", { class: "check" }, all));
  for (const c of result.columns) {
    const arrow = sort && sort.property === c.id ? (sort.direction === "DESC" ? " ↓" : " ↑") : "";
    const th = el("th", { title: `${c.id} — click to sort` }, c.label + arrow);
    th.onclick = () => send({ type: "sort", sort: nextSort(c.id) });
    head.append(th);
  }

  const body = el("tbody");
  for (const row of rows) {
    const box = el("input", { type: "checkbox" });
    box.checked = selected.has(row.uri);
    box.onclick = (e) => {
      toggle(row.uri, rows, e.shiftKey);
      renderTable();
    };
    const tr = el("tr", { class: selected.has(row.uri) ? "selected" : "" }, el("td", { class: "check" }, box));
    if (row.readOnly) tr.title = row.readOnly;
    for (const c of result.columns) {
      const td = el("td", {}, display(row.cells[c.id]));
      if (c.id === "file.name" || c.id === "file.path" || c.id === "file.basename") {
        td.className = "file";
        td.onclick = () => send({ type: "open", uri: row.uri });
      } else if (c.editable && !row.readOnly) {
        td.className = "editable";
        td.ondblclick = () => startEdit(td, row, c.id);
      } else {
        td.className = "readonly";
      }
      tr.append(td);
    }
    body.append(tr);
  }

  const table = el("table", {}, el("thead", {}, head), body);
  host.replaceChildren(rows.length > 0 ? table : el("p", { class: "empty" }, result.rows.length > 0 ? "No row matches the search." : "No file matches the filters of this view."));

  const count = document.getElementById("count");
  if (count) count.textContent = `${rows.length}${rows.length !== result.total ? ` of ${result.total}` : ""} files`;
  const bulk = document.getElementById("bulk");
  if (bulk) bulk.hidden = selected.size === 0;
  const sel = document.getElementById("selection");
  if (sel) sel.textContent = `${selected.size} selected`;
}

function render(): void {
  // Re-rendering replaces the inputs; put the focus and caret back where they were.
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : undefined;
  const focusClass = focused?.className;
  const caret = focused?.selectionStart ?? null;
  const parts: HTMLElement[] = [];
  if (result) parts.push(toolbar());
  if (error) parts.push(el("div", { class: "banner error" }, error));
  for (const e of result?.errors ?? []) parts.push(el("div", { class: "banner warn" }, e));
  if (notice) parts.push(el("div", { class: "banner info" }, notice));
  if (result) parts.push(bulkBar(), el("div", { id: "table-host", class: "table-host" }));
  app.replaceChildren(...parts);
  renderTable();
  if (focusClass) {
    const again = app.querySelector<HTMLInputElement>(`input.${focusClass.split(" ")[0]}`);
    again?.focus();
    if (again && caret !== null && again.type !== "checkbox") again.setSelectionRange(caret, caret);
  }
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
      result = msg.result;
      error = undefined;
      // Do not pull an open cell edit out from under the person typing.
      if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("cell-input")) return;
      render();
      break;
    case "error":
      error = msg.message;
      render();
      break;
    case "notice":
      notice = msg.message;
      clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        notice = undefined;
        render();
      }, 3000);
      render();
      break;
  }
});

send({ type: "ready" });
