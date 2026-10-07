// The table UI of a base. The host computes every render; the UI sends back
// what the person changed: cell values, and the base itself (views, filters,
// columns, sort, formulas) the way Obsidian Bases lets you edit it.

import type { PropertyInfo, Row } from "../src/core/base";
import {
  CONJUNCTIONS,
  conditionExpr,
  fromModel,
  OPERATORS,
  type Conjunction,
  type FilterGroup,
  type FilterNode,
  type Operator,
} from "../src/core/filterModel";
import type { BaseOp, FromWebview, SortSpec, ToWebview, UiEdit, UiState, ViewResult } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
const send = (msg: FromWebview) => vscode.postMessage(msg);
const ops = (...list: BaseOp[]) => send({ type: "baseOps", ops: list });
const setUi = (state: Partial<UiState>) => send({ type: "ui", state });

type Panel = "sort" | "filter" | "properties" | "view" | undefined;

let result: ViewResult | undefined;
let error: string | undefined;
let notice: string | undefined;
let noticeTimer: number | undefined;
let panel: Panel;
let filterScope: "view" | "base" = "view";
let search = "";
let searchTimer: number | undefined;
let propertySearch = "";
const selected = new Set<string>();
let lastClicked: string | undefined;
// The bulk-edit inputs survive re-renders, so one edit can follow another.
const bulk = { key: "", value: "", target: "" };
// Filter edits in progress. A condition without its value is not written to
// the file yet, so the draft keeps it on screen until it is complete.
const drafts: { base?: FilterGroup; view?: { index: number; group: FilterGroup } } = {};

const app = document.getElementById("app")!;

// --- small DOM helpers --------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, cls = "secondary", title?: string): HTMLButtonElement {
  const b = el("button", { class: cls, title }, label);
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

/** A text input that reports on Enter or blur, and keeps unsent typing across re-renders (by key). */
function textInput(key: string, value: string, onCommit: (v: string) => void, attrs: Record<string, string> = {}): HTMLInputElement {
  const input = el("input", { ...attrs, "data-key": key, value });
  input.dataset.orig = value;
  input.onchange = () => {
    if (input.value !== input.dataset.orig) onCommit(input.value);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") input.blur();
  };
  return input;
}

function select<T extends string>(key: string, options: { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el("select", { "data-key": key }, ...options.map((o) => el("option", { value: o.value }, o.label)));
  s.value = value;
  s.onchange = () => onChange(s.value as T);
  return s;
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

/** `status`, `file.name`, or `formula.score (Score)` when a display name is set. */
function propLabel(p: PropertyInfo): string {
  if (p.ns === "note") return p.label === p.id ? p.id : `${p.id} (${p.label})`;
  return p.label === p.id.slice(p.ns.length + 1) ? p.id : `${p.id} (${p.label})`;
}

function propertyOptions(extra: string[] = []): { value: string; label: string }[] {
  const props: PropertyInfo[] = result?.properties ?? [];
  const known = new Set(props.map((p) => p.id));
  return [
    ...props.map((p) => ({ value: p.id, label: propLabel(p) })),
    ...extra.filter((id) => !known.has(id)).map((id) => ({ value: id, label: id })),
  ];
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

// --- views ------------------------------------------------------------------

function viewTabs(): HTMLElement {
  const r = result!;
  const tabs = el("div", { class: "tabs" });
  r.views.forEach((v, i) => {
    const b = button(v.name, () => setUi({ viewIndex: i }), i === r.viewIndex ? "tab active" : "tab", v.type);
    tabs.append(b);
  });
  tabs.append(
    button("+", () => {
      ops({ op: "addView", name: uniqueName("Table", r.views.map((v) => v.name)) });
      panel = "view";
    }, "tab icon", "Add view"),
    button("⋯", () => togglePanel("view"), panel === "view" ? "tab icon active" : "tab icon", "View settings"),
  );
  return tabs;
}

function viewPanel(): HTMLElement {
  const r = result!;
  const i = r.viewIndex;
  const name = textInput("view-name", r.view.name, (v) => v.trim() && ops({ op: "setView", index: i, key: "name", value: v.trim() }));
  const limit = textInput("view-limit", r.view.limit !== undefined ? String(r.view.limit) : "", (v) => {
    const n = Number.parseInt(v, 10);
    ops({ op: "setView", index: i, key: "limit", value: Number.isFinite(n) && n > 0 ? n : undefined });
  }, { type: "number", min: "1", placeholder: "no limit", class: "narrow" });
  const remove = button("Delete view", () => ops({ op: "removeView", index: i }), "danger");
  remove.disabled = r.views.length <= 1;
  return el("div", { class: "panel" },
    el("div", { class: "panel-title" }, "View"),
    el("label", { class: "field" }, el("span", {}, "Name"), name),
    el("label", { class: "field" }, el("span", {}, "Result limit"), limit),
    el("div", { class: "row" },
      button("Duplicate view", () => ops({ op: "duplicateView", index: i, name: uniqueName(`${r.view.name} copy`, r.views.map((v) => v.name)) })),
      remove),
  );
}

// --- sort ---------------------------------------------------------------------

function nextSort(column: string): SortSpec[] {
  const current = result?.sort[0];
  if (!current || current.property !== column) return [{ property: column, direction: "ASC" }];
  if (current.direction === "ASC") return [{ property: column, direction: "DESC" }];
  return [];
}

function sortPanel(): HTMLElement {
  const r = result!;
  const setSort = (sort: SortSpec[]) => ops({ op: "setView", index: r.viewIndex, key: "sort", value: sort });
  const rows = r.sort.map((s, i) =>
    el("div", { class: "row" },
      select(`sort-p-${i}`, propertyOptions([s.property]), s.property, (v) => setSort(r.sort.map((x, j) => (j === i ? { ...x, property: v } : x)))),
      select(`sort-d-${i}`, [{ value: "ASC", label: "Ascending" }, { value: "DESC", label: "Descending" }], s.direction, (v) => setSort(r.sort.map((x, j) => (j === i ? { ...x, direction: v } : x)))),
      button("×", () => setSort(r.sort.filter((_, j) => j !== i)), "icon", "Remove sort"),
    ),
  );
  const unused = r.properties.find((p) => !r.sort.some((s) => s.property === p.id));
  return el("div", { class: "panel" },
    el("div", { class: "panel-title" }, "Sort"),
    ...(rows.length > 0 ? rows : [el("p", { class: "hint" }, "Not sorted: files appear by path.")]),
    el("div", { class: "row" }, button("+ Add sort", () => setSort([...r.sort, { property: unused?.id ?? "file.name", direction: "ASC" }]), "link")),
  );
}

// --- filters ------------------------------------------------------------------

function currentFilter(): FilterGroup {
  const r = result!;
  if (filterScope === "base") return drafts.base ?? r.baseFilter;
  return drafts.view && drafts.view.index === r.viewIndex ? drafts.view.group : r.viewFilter;
}

function writeFilter(group: FilterGroup): void {
  const r = result!;
  const filters = fromModel(group);
  if (filterScope === "base") {
    drafts.base = group;
    ops({ op: "setBaseFilters", filters });
  } else {
    drafts.view = { index: r.viewIndex, group };
    ops({ op: "setView", index: r.viewIndex, key: "filters", value: filters });
  }
  render();
}

/** Drops a draft once the file says something else, e.g. after an edit by hand. */
function reconcileDrafts(r: ViewResult): void {
  const same = (draft: FilterGroup, raw: unknown) => JSON.stringify(fromModel(draft) ?? null) === JSON.stringify(raw ?? null);
  if (drafts.base && !same(drafts.base, r.rawFilters.base)) drafts.base = undefined;
  if (drafts.view && (drafts.view.index !== r.viewIndex || !same(drafts.view.group, r.rawFilters.view))) drafts.view = undefined;
}

function countConditions(g: FilterGroup): number {
  return g.children.reduce((n, c) => n + (c.kind === "group" ? countConditions(c) : 1), 0);
}

/** Edits a copy of the filter tree at `path` and writes it. */
function updateFilter(path: number[], change: (node: FilterNode, parent: FilterGroup | undefined, index: number) => FilterNode | null): void {
  const root = structuredClone(currentFilter());
  let parent: FilterGroup | undefined;
  let node: FilterNode = root;
  for (const i of path) {
    parent = node as FilterGroup;
    node = parent.children[i]!;
  }
  const next = change(node, parent, path.at(-1) ?? 0);
  if (!parent) {
    writeFilter((next ?? { kind: "group", conj: "and", children: [] }) as FilterGroup);
    return;
  }
  const i = path.at(-1)!;
  if (next === null) parent.children.splice(i, 1);
  else parent.children[i] = next;
  writeFilter(root);
}

function operatorsFor(property: string): { value: Operator; label: string }[] {
  return OPERATORS.filter((o) => !o.only || o.only === property).map((o) => ({ value: o.op, label: o.label }));
}

function filterNode(node: FilterNode, path: number[], depth: number): HTMLElement {
  const key = `f-${filterScope}-${path.join(".")}`;
  if (node.kind === "group") {
    const head = el("div", { class: "row" },
      select(`${key}-conj`, CONJUNCTIONS.map((c) => ({ value: c.conj, label: c.label })), node.conj, (v: Conjunction) => updateFilter(path, (n) => ({ ...(n as FilterGroup), conj: v }))),
    );
    if (depth > 0) head.append(button("×", () => updateFilter(path, () => null), "icon", "Remove group"));
    return el("div", { class: depth > 0 ? "filter-group nested" : "filter-group" },
      head,
      ...node.children.map((c, i) => filterNode(c, [...path, i], depth + 1)),
      el("div", { class: "row" },
        button("+ Add filter", () => updateFilter(path, (n) => ({ ...(n as FilterGroup), children: [...(n as FilterGroup).children, { kind: "cond", property: "file.name", op: "contains", value: "" }] })), "link"),
        button("+ Add filter group", () => updateFilter(path, (n) => ({ ...(n as FilterGroup), children: [...(n as FilterGroup).children, { kind: "group", conj: "and", children: [] }] })), "link"),
      ),
    );
  }
  if (node.kind === "expr") {
    return el("div", { class: "row" },
      textInput(`${key}-expr`, node.expr, (v) => updateFilter(path, () => ({ kind: "expr", expr: v })), { class: "expr", placeholder: 'e.g. date(due) < today() && status != "done"' }),
      button("×", () => updateFilter(path, () => null), "icon", "Remove filter"),
    );
  }
  const op = OPERATORS.find((o) => o.op === node.op)!;
  const row = el("div", { class: "row" },
    select(`${key}-p`, propertyOptions([node.property]), node.property, (v) =>
      updateFilter(path, (n) => {
        const c = n as Extract<FilterNode, { kind: "cond" }>;
        // An operator that only fits the old property falls back to "is".
        const fits = operatorsFor(v).some((o) => o.value === c.op);
        return { ...c, property: v, op: fits ? c.op : v === "file.tags" ? "hasTag" : v === "file.folder" ? "inFolder" : "is" };
      })),
    select(`${key}-op`, operatorsFor(node.property), node.op, (v) => updateFilter(path, (n) => ({ ...(n as Extract<FilterNode, { kind: "cond" }>), op: v }))),
  );
  if (op.needsValue) row.append(textInput(`${key}-v`, node.value, (v) => updateFilter(path, (n) => ({ ...(n as Extract<FilterNode, { kind: "cond" }>), value: v })), { placeholder: "value" }));
  row.append(
    button("</>", () => updateFilter(path, (n) => ({ kind: "expr", expr: conditionExpr(n as Extract<FilterNode, { kind: "cond" }>) })), "icon", "Edit as expression"),
    button("×", () => updateFilter(path, () => null), "icon", "Remove filter"),
  );
  return row;
}

function filterPanel(): HTMLElement {
  const r = result!;
  const scope = (s: "view" | "base", label: string) =>
    button(label, () => {
      filterScope = s;
      render();
    }, filterScope === s ? "tab active" : "tab");
  return el("div", { class: "panel" },
    el("div", { class: "row" },
      el("span", { class: "panel-title" }, "Filters"),
      scope("view", `This view (${countConditions(drafts.view?.index === r.viewIndex ? drafts.view.group : r.viewFilter)})`),
      scope("base", `All views (${countConditions(drafts.base ?? r.baseFilter)})`),
    ),
    filterNode(currentFilter(), [], 0),
  );
}

// --- properties (columns and formulas) ------------------------------------------

function propertiesPanel(): HTMLElement {
  const r = result!;
  const order = r.view.order;
  const setOrder = (next: string[]) => ops({ op: "setView", index: r.viewIndex, key: "order", value: next });
  const q = propertySearch.trim().toLowerCase();
  const shown = order.map((id) => r.properties.find((p) => p.id === id) ?? { id, label: id, ns: "note" as const });
  const hidden = r.properties.filter((p) => !order.includes(p.id));
  const matchesQuery = (p: PropertyInfo) => !q || p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q);

  const item = (p: PropertyInfo, visible: boolean) => {
    const box = el("input", { type: "checkbox" });
    box.checked = visible;
    box.onchange = () => setOrder(visible ? order.filter((id) => id !== p.id) : [...order, p.id]);
    const li = el("li", { class: visible ? "prop visible" : "prop", title: p.id },
      el("span", { class: "grip" }, visible ? "⋮⋮" : ""),
      box,
      el("span", { class: `prop-name ns-${p.ns}` }, propLabel(p)),
    );
    if (p.ns === "formula") {
      const name = p.id.slice("formula.".length);
      li.append(
        textInput(`formula-${name}`, r.formulas[name] ?? "", (v) => v.trim() && ops({ op: "setFormula", name, expr: v.trim() }), { class: "expr small", title: "Formula" }),
        button("×", () => ops({ op: "setFormula", name, expr: undefined }), "icon", "Delete formula"),
      );
    }
    if (visible) {
      li.draggable = true;
      li.ondragstart = (e) => e.dataTransfer?.setData("text/plain", p.id);
      li.ondragover = (e) => {
        e.preventDefault();
        li.classList.add("drop");
      };
      li.ondragleave = () => li.classList.remove("drop");
      li.ondrop = (e) => {
        e.preventDefault();
        const moved = e.dataTransfer?.getData("text/plain");
        if (!moved || moved === p.id) return;
        const next = order.filter((id) => id !== moved);
        next.splice(next.indexOf(p.id), 0, moved);
        setOrder(next);
      };
    }
    return li;
  };

  const filterBox = el("input", { type: "search", placeholder: "Search properties…", value: propertySearch, "data-key": "prop-search", class: "wide" });
  filterBox.oninput = () => {
    propertySearch = filterBox.value;
    render();
  };

  // data-orig marks them as inputs whose typing survives a re-render.
  const fName = el("input", { placeholder: "formula name", "data-key": "new-formula-name", "data-orig": "", class: "narrow" });
  const fExpr = el("input", { placeholder: 'expression, e.g. priority * 2 or if(done, "✓", "")', "data-key": "new-formula-expr", "data-orig": "", class: "expr" });
  const addFormula = () => {
    const name = fName.value.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      fName.focus();
      return;
    }
    if (!fExpr.value.trim()) {
      fExpr.focus();
      return;
    }
    ops({ op: "setFormula", name, expr: fExpr.value.trim() }, { op: "setView", index: r.viewIndex, key: "order", value: [...order.filter((id) => id !== `formula.${name}`), `formula.${name}`] });
    fName.value = "";
    fExpr.value = "";
  };

  return el("div", { class: "panel" },
    el("div", { class: "panel-title" }, "Properties"),
    filterBox,
    el("ul", { class: "props" }, ...shown.filter(matchesQuery).map((p) => item(p, true)), ...hidden.filter(matchesQuery).map((p) => item(p, false))),
    el("div", { class: "row" }, fName, fExpr, button("+ Add formula", addFormula, "link")),
  );
}

// --- toolbar, bulk bar, table, pager ------------------------------------------------

function togglePanel(p: Panel): void {
  panel = panel === p ? undefined : p;
  render();
}

function toolbar(): HTMLElement {
  const r = result!;
  const filters = countConditions(r.viewFilter) + countConditions(r.baseFilter);
  const searchBox = el("input", { type: "search", placeholder: "Search…", value: search, class: "search", "data-key": "search" });
  searchBox.oninput = () => {
    search = searchBox.value;
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => setUi({ query: search }), 200);
  };
  return el("div", { class: "toolbar" },
    viewTabs(),
    el("span", { class: "spacer" }),
    button(r.sort.length ? `Sort (${r.sort.length})` : "Sort", () => togglePanel("sort"), panel === "sort" ? "tool active" : "tool"),
    button(filters ? `Filter (${filters})` : "Filter", () => togglePanel("filter"), panel === "filter" ? "tool active" : "tool"),
    button("Properties", () => togglePanel("properties"), panel === "properties" ? "tool active" : "tool"),
    searchBox,
    el("span", { class: "count" }, `${r.allUris.length} ${r.allUris.length === 1 ? "result" : "results"}`),
    button("YAML", () => send({ type: "openAsText" }), "tool", "Edit the .base file as text"),
  );
}

function edit(uris: string[], edits: UiEdit[]): void {
  send({ type: "edit", uris, edits });
}

function bulkBar(): HTMLElement {
  const r = result!;
  const list = el("datalist", { id: "props" }, ...r.propertyNames.map((p) => el("option", { value: p })));
  const key = el("input", { placeholder: "property", list: "props", class: "key", value: bulk.key, "data-key": "bulk-key" });
  const value = el("input", { placeholder: "value (YAML: 3, true, [a, b])", class: "value", value: bulk.value, "data-key": "bulk-value" });
  const target = el("input", { placeholder: "new name", class: "key", value: bulk.target, "data-key": "bulk-target" });
  key.oninput = () => (bulk.key = key.value);
  value.oninput = () => (bulk.value = value.value);
  target.oninput = () => (bulk.target = target.value);
  const uris = () => [...selected];
  const needKey = () => {
    if (!key.value.trim()) key.focus();
    return Boolean(key.value.trim());
  };

  const bar = el("div", { class: "bulk" },
    el("span", { class: "selection" }, `${selected.size} selected`),
    list, key, value,
    button("Set", () => needKey() && edit(uris(), [{ kind: "set", key: key.value.trim(), input: value.value }]), "primary"),
    button("Remove", () => needKey() && edit(uris(), [{ kind: "delete", key: key.value.trim() }])),
    el("span", { class: "sep" }, "→"),
    target,
    button("Rename", () => needKey() && target.value.trim() && edit(uris(), [{ kind: "rename", from: key.value.trim(), to: target.value.trim() }])),
  );
  if (selected.size < r.allUris.length && r.rows.every((row) => selected.has(row.uri))) {
    bar.append(button(`Select all ${r.allUris.length}`, () => {
      for (const u of r.allUris) selected.add(u);
      render();
    }, "link"));
  }
  bar.append(button("Clear selection", () => {
    selected.clear();
    render();
  }, "link"));
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

function table(): HTMLElement {
  const r = result!;
  const rows = r.rows;
  if (rows.length === 0) {
    return el("p", { class: "empty" }, search ? "No file matches the search." : "No file matches the filters of this view.");
  }
  const sort = r.sort[0];
  const all = el("input", { type: "checkbox", title: "Select the rows on this page" });
  all.checked = rows.every((row) => selected.has(row.uri));
  all.onchange = () => {
    for (const row of rows) all.checked ? selected.add(row.uri) : selected.delete(row.uri);
    render();
  };
  const head = el("tr", {}, el("th", { class: "check" }, all));
  for (const c of r.columns) {
    const arrow = sort && sort.property === c.id ? (sort.direction === "DESC" ? " ↓" : " ↑") : "";
    const th = el("th", { title: `${c.id} — click to sort` }, c.label + arrow);
    th.onclick = () => ops({ op: "setView", index: r.viewIndex, key: "sort", value: nextSort(c.id) });
    head.append(th);
  }

  const body = el("tbody");
  for (const row of rows) {
    const box = el("input", { type: "checkbox" });
    box.checked = selected.has(row.uri);
    box.onclick = (e) => {
      toggle(row.uri, rows, e.shiftKey);
      render();
    };
    const tr = el("tr", { class: selected.has(row.uri) ? "selected" : "", title: row.readOnly }, el("td", { class: "check" }, box));
    for (const c of r.columns) {
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
  return el("table", {}, el("thead", {}, head), body);
}

function pager(): HTMLElement {
  const r = result!;
  const from = r.allUris.length === 0 ? 0 : r.page * r.pageSize + 1;
  const to = Math.min((r.page + 1) * r.pageSize, r.allUris.length);
  const prev = button("‹ Previous", () => setUi({ page: r.page - 1 }));
  prev.disabled = r.page === 0;
  const next = button("Next ›", () => setUi({ page: r.page + 1 }));
  next.disabled = r.page >= r.pageCount - 1;
  const sizes = [25, 50, 100, 250, 500];
  if (!sizes.includes(r.pageSize)) sizes.push(r.pageSize);
  return el("div", { class: "pager" },
    el("span", { class: "count" }, `${from}–${to} of ${r.allUris.length}`),
    prev,
    el("span", {}, `Page ${r.page + 1} of ${r.pageCount}`),
    next,
    el("span", { class: "spacer" }),
    el("label", { class: "count" }, "Rows per page ",
      select("page-size", sizes.sort((a, b) => a - b).map((n) => ({ value: String(n), label: String(n) })), String(r.pageSize), (v) => setUi({ pageSize: Number(v), page: 0 }))),
  );
}

// --- render -------------------------------------------------------------------

function render(): void {
  // Re-rendering replaces every input: keep focus, caret and unsent typing.
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active?.dataset?.key;
  const caret = active && "selectionStart" in active && active.type !== "number" ? active.selectionStart : null;
  const typed = new Map<string, string>();
  for (const input of app.querySelectorAll<HTMLInputElement>("input[data-orig]")) {
    if (input.value !== input.dataset.orig) typed.set(input.dataset.key!, input.value);
  }

  const parts: HTMLElement[] = [];
  if (result) {
    parts.push(toolbar());
    if (panel === "view") parts.push(viewPanel());
    if (panel === "sort") parts.push(sortPanel());
    if (panel === "filter") parts.push(filterPanel());
    if (panel === "properties") parts.push(propertiesPanel());
  }
  if (error) parts.push(el("div", { class: "banner error" }, error));
  for (const e of result?.errors ?? []) parts.push(el("div", { class: "banner warn" }, e));
  if (notice) parts.push(el("div", { class: "banner info" }, notice));
  if (result) {
    const known = new Set(result.allUris);
    for (const u of [...selected]) if (!known.has(u)) selected.delete(u);
    if (selected.size > 0) parts.push(bulkBar());
    parts.push(el("div", { class: "table-host" }, table()));
    if (result.pageCount > 1 || result.allUris.length > 25) parts.push(pager());
  }
  app.replaceChildren(...parts);

  for (const [key, value] of typed) {
    const input = app.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(key)}"]`);
    if (input) input.value = value;
  }
  if (focusKey) {
    const again = app.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(focusKey)}"]`);
    again?.focus();
    if (again instanceof HTMLInputElement && caret !== null && again.type !== "checkbox" && again.type !== "number") again.setSelectionRange(caret, caret);
  }
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
      result = msg.result;
      error = undefined;
      reconcileDrafts(msg.result);
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
