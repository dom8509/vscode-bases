// The table UI of a base. The host computes every render; the UI sends back
// what the person changed: cell values, and the base itself (views, filters,
// columns, sort, formulas) the way Obsidian Bases lets you edit it.

import type { Column, PropertyInfo, Row } from "../src/core/base";
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
import { icon, type IconName } from "./icons";
import type { BaseOp, EditTarget, FromWebview, IndexProgress, SortSpec, ToWebview, UiEdit, UiState, ViewResult } from "../src/protocol";

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
// The search box shows only when asked for, as in Obsidian.
let searchOpen = false;
let searchTimer: number | undefined;
let propertySearch = "";
// The selection: a set of files, or every file the view matches minus some.
// "Every match" stays a flag: the host resolves it to files only for an edit.
const selection = { uris: new Set<string>(), all: false, except: new Set<string>(), scope: "" };
let lastClicked: string | undefined;
let indexing: IndexProgress | undefined;

function isSelected(uri: string): boolean {
  return selection.all ? !selection.except.has(uri) : selection.uris.has(uri);
}

function setSelected(uri: string, on: boolean): void {
  if (selection.all) on ? selection.except.delete(uri) : selection.except.add(uri);
  else on ? selection.uris.add(uri) : selection.uris.delete(uri);
}

function selectionCount(): number {
  return selection.all ? Math.max(0, (result?.matchCount ?? 0) - selection.except.size) : selection.uris.size;
}

function clearSelection(): void {
  selection.uris.clear();
  selection.all = false;
  selection.except.clear();
}

function selectionTarget(): EditTarget {
  return selection.all ? { allMatching: true, except: [...selection.except] } : { uris: [...selection.uris] };
}

/** "Every match" means the matches of what was shown: a new view, filter or search ends it. */
function rescopeSelection(r: ViewResult): void {
  const scope = JSON.stringify([r.viewIndex, r.rawFilters, search]);
  if (scope === selection.scope) return;
  const otherView = !selection.scope.startsWith(`[${r.viewIndex},`);
  selection.scope = scope;
  selection.all = false;
  selection.except.clear();
  if (otherView) selection.uris.clear();
}
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

function button(label: string | Node, onClick: () => void, cls = "secondary", title?: string): HTMLButtonElement {
  const b = el("button", { class: cls, title, "aria-label": title }, label);
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

/** A borderless button with an icon and, optionally, a label next to it. */
function iconButton(name: IconName, label: string | undefined, onClick: () => void, cls = "", title?: string): HTMLButtonElement {
  const b = button(icon(name), onClick, `clickable-icon ${cls}`.trim(), title ?? label);
  if (label) b.append(el("span", { class: "label" }, label));
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

const VIEW_ICONS: Record<string, IconName> = { table: "table", cards: "cards", list: "list", map: "map" };
let viewMenuOpen = false;

function closeViewMenu(): void {
  if (!viewMenuOpen) return;
  viewMenuOpen = false;
  render();
}

/** The view picker: a dropdown with the views, their settings, and "Add view", as in Obsidian. */
function viewSwitcher(): HTMLElement {
  const r = result!;
  const viewIcon = (type: string) => el("span", { class: "view-icon" }, icon(VIEW_ICONS[type] ?? "table"));
  const toggle = button("", () => {
    viewMenuOpen = !viewMenuOpen;
    if (viewMenuOpen) panel = undefined;
    render();
  }, viewMenuOpen || panel === "view" ? "view-button open" : "view-button", "Switch view");
  toggle.append(viewIcon(r.views[r.viewIndex]?.type ?? "table"), el("span", { class: "view-label" }, r.view.name), el("span", { class: "chevron" }, icon("chevronDown")));

  const wrap = el("div", { class: "view-switcher anchor" }, toggle);
  if (panel === "view") wrap.append(popover(viewPanel(), "left"));
  if (!viewMenuOpen) return wrap;

  const items = r.views.map((v, i) => {
    const item = el("div", { class: i === r.viewIndex ? "view-item active" : "view-item", role: "menuitem", tabindex: "0", "data-key": `view-item-${i}` },
      viewIcon(v.type),
      el("span", { class: "view-label" }, v.name),
      el("span", { class: "check" }, ...(i === r.viewIndex ? [icon("check")] : [])),
      iconButton("settings", undefined, () => {
        viewMenuOpen = false;
        panel = "view";
        if (i === r.viewIndex) render();
        else setUi({ viewIndex: i });
      }, "", "Configure view"),
    );
    const choose = () => {
      viewMenuOpen = false;
      if (i === r.viewIndex) render();
      else setUi({ viewIndex: i });
    };
    item.onclick = choose;
    item.onkeydown = (e) => {
      if (e.key === "Enter") choose();
    };
    return item;
  });
  const add = el("div", { class: "view-item add", role: "menuitem", tabindex: "0", "data-key": "view-item-add" }, el("span", { class: "view-icon" }, icon("plus")), el("span", { class: "view-label" }, "Add view"));
  add.onclick = () => {
    viewMenuOpen = false;
    panel = "view";
    ops({ op: "addView", name: uniqueName("Table", r.views.map((v) => v.name)) });
  };
  add.onkeydown = (e) => {
    if (e.key === "Enter") add.click();
  };
  wrap.append(el("div", { class: "view-menu", role: "menu" }, ...items, el("div", { class: "menu-sep" }), add));
  return wrap;
}

function viewPanel(): HTMLElement {
  const r = result!;
  const i = r.viewIndex;
  const name = textInput("view-name", r.view.name, (v) => v.trim() && ops({ op: "setView", index: i, key: "name", value: v.trim() }));
  const limit = textInput("view-limit", r.view.limit !== undefined ? String(r.view.limit) : "", (v) => {
    const n = Number.parseInt(v, 10);
    ops({ op: "setView", index: i, key: "limit", value: Number.isFinite(n) && n > 0 ? n : undefined });
  }, { type: "number", min: "1", placeholder: "no limit", class: "narrow" });
  const remove = iconButton("trash", "Delete view", () => ops({ op: "removeView", index: i }), "danger");
  remove.disabled = r.views.length <= 1;
  return el("div", { class: "panel" },
    el("div", { class: "panel-title" }, "View settings"),
    el("label", { class: "field" }, el("span", {}, "Name"), name),
    el("label", { class: "field" }, el("span", {}, "Result limit"), limit),
    el("div", { class: "row" },
      iconButton("copy", "Duplicate view", () => ops({ op: "duplicateView", index: i, name: uniqueName(`${r.view.name} copy`, r.views.map((v) => v.name)) })),
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
      iconButton("x", undefined, () => setSort(r.sort.filter((_, j) => j !== i)), "", "Remove sort"),
    ),
  );
  const unused = r.properties.find((p) => !r.sort.some((s) => s.property === p.id));
  return el("div", { class: "panel" },
    el("div", { class: "panel-title" }, "Sort"),
    ...(rows.length > 0 ? rows : [el("p", { class: "hint" }, "Not sorted: files appear by path.")]),
    el("div", { class: "row" }, iconButton("plus", "Add sort", () => setSort([...r.sort, { property: unused?.id ?? "file.name", direction: "ASC" }]), "add")),
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
    if (depth > 0) head.append(iconButton("x", undefined, () => updateFilter(path, () => null), "", "Remove group"));
    return el("div", { class: depth > 0 ? "filter-group nested" : "filter-group" },
      head,
      ...node.children.map((c, i) => filterNode(c, [...path, i], depth + 1)),
      el("div", { class: "row" },
        iconButton("plus", "Add filter", () => updateFilter(path, (n) => ({ ...(n as FilterGroup), children: [...(n as FilterGroup).children, { kind: "cond", property: "file.name", op: "contains", value: "" }] })), "add"),
        iconButton("plus", "Add filter group", () => updateFilter(path, (n) => ({ ...(n as FilterGroup), children: [...(n as FilterGroup).children, { kind: "group", conj: "and", children: [] }] })), "add"),
      ),
    );
  }
  if (node.kind === "expr") {
    return el("div", { class: "row" },
      textInput(`${key}-expr`, node.expr, (v) => updateFilter(path, () => ({ kind: "expr", expr: v })), { class: "expr", placeholder: 'e.g. date(due) < today() && status != "done"' }),
      iconButton("x", undefined, () => updateFilter(path, () => null), "", "Remove filter"),
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
    iconButton("code", undefined, () => updateFilter(path, (n) => ({ kind: "expr", expr: conditionExpr(n as Extract<FilterNode, { kind: "cond" }>) })), "", "Edit as expression"),
    iconButton("x", undefined, () => updateFilter(path, () => null), "", "Remove filter"),
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
      el("span", { class: "grip" }, ...(visible ? [icon("grip")] : [])),
      box,
      el("span", { class: `prop-name ns-${p.ns}` }, propLabel(p)),
    );
    if (p.ns === "formula") {
      const name = p.id.slice("formula.".length);
      li.append(
        textInput(`formula-${name}`, r.formulas[name] ?? "", (v) => v.trim() && ops({ op: "setFormula", name, expr: v.trim() }), { class: "expr small", title: "Formula" }),
        iconButton("x", undefined, () => ops({ op: "setFormula", name, expr: undefined }), "", "Delete formula"),
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
    el("div", { class: "row" }, fName, fExpr, iconButton("sigma", "Add formula", addFormula, "add")),
  );
}

// --- toolbar, bulk bar, table, pager ------------------------------------------------

function closePanel(): void {
  panel = undefined;
  render();
}

function togglePanel(p: Panel): void {
  panel = panel === p ? undefined : p;
  render();
}

/** A floating window under its toolbar button, as Obsidian shows the view, sort, filter and properties menus. */
function popover(content: HTMLElement, align: "left" | "right"): HTMLElement {
  content.classList.add("popover", `align-${align}`);
  content.prepend(iconButton("x", undefined, closePanel, "panel-close", "Close (Escape)"));
  return content;
}

/** A toolbar button and, while it is open, its popover. */
function tool(p: Exclude<Panel, "view" | undefined>, name: IconName, label: string, count: number, content: () => HTMLElement): HTMLElement {
  const b = iconButton(name, label, () => togglePanel(p), panel === p ? "tool active" : "tool");
  if (count) b.append(el("span", { class: "badge" }, String(count)));
  const wrap = el("div", { class: "anchor" }, b);
  if (panel === p) wrap.append(popover(content(), "right"));
  return wrap;
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
  searchBox.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  };
  const searchToggle = iconButton("search", undefined, () => (searchOpen ? closeSearch() : openSearch()), searchOpen || search ? "tool active" : "tool", searchOpen ? "Close search (Escape)" : "Search");
  return el("div", { class: "toolbar" },
    viewSwitcher(),
    el("span", { class: "count", title: indexing?.checking ? "Showing the cached index while checking files for changes" : undefined },
      `${r.matchCount.toLocaleString()} ${r.matchCount === 1 ? "result" : "results"}${indexing?.checking ? " · updating…" : ""}`),
    el("span", { class: "spacer" }),
    tool("sort", "sort", "Sort", r.sort.length, sortPanel),
    tool("filter", "filter", "Filter", filters, filterPanel),
    tool("properties", "properties", "Properties", 0, propertiesPanel),
    ...(searchOpen ? [el("label", { class: "search-box" }, searchBox)] : []),
    searchToggle,
  );
}

function openSearch(): void {
  searchOpen = true;
  render();
  app.querySelector<HTMLInputElement>('input[data-key="search"]')?.focus();
}

/** Hiding the search also ends it: what is hidden does not filter. */
function closeSearch(): void {
  searchOpen = false;
  clearTimeout(searchTimer);
  if (search) {
    search = "";
    setUi({ query: "" });
  }
  render();
}

function edit(target: EditTarget, edits: UiEdit[], confirmed = false): void {
  send({ type: "edit", target, edits, confirmed });
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
  const uris = selectionTarget;
  const needKey = () => {
    if (!key.value.trim()) key.focus();
    return Boolean(key.value.trim());
  };

  const bar = el("div", { class: "bulk" },
    el("span", { class: "selection" }, `${selectionCount()} selected`),
    list, key, value,
    button("Set", () => needKey() && edit(uris(), [{ kind: "set", key: key.value.trim(), input: value.value }]), "primary"),
    button("Remove", () => needKey() && edit(uris(), [{ kind: "delete", key: key.value.trim() }])),
    el("span", { class: "sep" }, "→"),
    target,
    button("Rename", () => needKey() && target.value.trim() && edit(uris(), [{ kind: "rename", from: key.value.trim(), to: target.value.trim() }])),
  );
  if (selectionCount() < r.matchCount && r.rows.every((row) => isSelected(row.uri))) {
    bar.append(button(`Select all ${r.matchCount}`, () => {
      selection.all = true;
      selection.except.clear();
      selection.uris.clear();
      render();
    }, "link"));
  }
  bar.append(button("Clear selection", () => {
    clearSelection();
    render();
  }, "link"));
  return bar;
}

// --- editing cells -------------------------------------------------------------------

// While a cell editor is open, renders from the host wait, so the editor is not
// pulled out from under the person typing; they happen when it closes.
let editing = false;
let renderPending = false;

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** What a cell shows when it is not being edited. */
function cellContent(c: Column, row: Row): (Node | string)[] {
  const v = row.cells[c.id];
  if (c.type === "checkbox") {
    const box = el("input", { type: "checkbox", class: "cell-check", title: c.editable ? "Click to toggle" : undefined });
    box.checked = v === true;
    box.disabled = !c.editable || Boolean(row.readOnly);
    box.onclick = (e) => {
      e.stopPropagation();
      commitValue(row, c, box.checked);
    };
    return [box];
  }
  if (c.type === "list" && Array.isArray(v)) return v.map((x) => el("span", { class: "chip" }, display(x)));
  return [display(v)];
}

/** True when a change to this row's cell is meant for every selected row. */
function editsSelection(row: Row): boolean {
  return isSelected(row.uri) && selectionCount() > 1;
}

/**
 * Shows the new value at once, then has the host write it. An empty value
 * removes the property. In a selected row the change goes to every selected
 * file, once the person says so in a short dialog.
 */
function commitValue(row: Row, c: Column, value: unknown, asYaml = false): void {
  const empty = isEmptyValue(value);
  const change: UiEdit = empty ? { kind: "delete", key: c.id } : asYaml ? { kind: "set", key: c.id, input: String(value) } : { kind: "setValue", key: c.id, value };
  if (!editsSelection(row)) {
    row.cells[c.id] = empty ? null : value;
    edit({ uris: [row.uri] }, [change]);
    return;
  }
  const n = selectionCount();
  const what = empty ? `Remove “${c.label}” from ${n} selected files?` : `Set “${c.label}” to ${display(value) || "this value"} in ${n} selected files?`;
  void choose(what, [
    { label: `Apply to ${n} files`, value: "all", primary: true },
    { label: "Only this file", value: "one" },
  ]).then((answer) => {
    if (answer === "all") {
      for (const r of result?.rows ?? []) if (isSelected(r.uri)) r.cells[c.id] = empty ? null : value;
      // Confirmed here: the host does not ask a second time.
      edit(selectionTarget(), [change], true);
    } else if (answer === "one") {
      row.cells[c.id] = empty ? null : value;
      edit({ uris: [row.uri] }, [change]);
    }
    render();
  });
}

/** A small modal question; resolves to the chosen value, or undefined on Cancel or Escape. */
function choose(message: string, options: { label: string; value: string; primary?: boolean }[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const before = document.activeElement as HTMLElement | null;
    const close = (value: string | undefined) => {
      overlay.remove();
      before?.focus();
      resolve(value);
    };
    const buttons = options.map((o) => button(o.label, () => close(o.value), o.primary ? "primary" : "secondary"));
    const box = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
      el("p", {}, message),
      el("div", { class: "dialog-buttons" }, ...buttons, button("Cancel", () => close(undefined), "secondary")),
    );
    const overlay = el("div", { class: "dialog-overlay" }, box);
    overlay.onmousedown = (e) => {
      if (e.target === overlay) close(undefined);
    };
    box.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        close(undefined);
      }
    };
    // Outside #app, so a render underneath leaves it alone.
    document.body.append(overlay);
    buttons.find((_, i) => options[i]!.primary)?.focus();
  });
}

function cellAt(rowIndex: number, colIndex: number): HTMLTableCellElement | null {
  return app.querySelector<HTMLTableCellElement>(`td[data-r="${rowIndex}"][data-c="${colIndex}"]`);
}

/** The next editable cell from (r, c) in a direction, wrapping to the next or previous row. */
function nextEditable(rowIndex: number, colIndex: number, move: "down" | "right" | "left"): [number, number] | undefined {
  const r = result!;
  const ok = (ri: number, ci: number) => r.columns[ci]?.editable && r.columns[ci]?.type !== "checkbox" && r.rows[ri] && !r.rows[ri]!.readOnly;
  if (move === "down") {
    for (let ri = rowIndex + 1; ri < r.rows.length; ri++) if (ok(ri, colIndex)) return [ri, colIndex];
    return undefined;
  }
  const step = move === "right" ? 1 : -1;
  let ri = rowIndex;
  let ci = colIndex + step;
  while (ri >= 0 && ri < r.rows.length) {
    while (ci >= 0 && ci < r.columns.length) {
      if (ok(ri, ci)) return [ri, ci];
      ci += step;
    }
    ri += step;
    ci = step > 0 ? 0 : r.columns.length - 1;
  }
  return undefined;
}

function dateValue(v: unknown, type: "date" | "datetime"): string {
  if (typeof v !== "string") return "";
  return type === "date" ? v.slice(0, 10) : v.replace(" ", "T").slice(0, 16);
}

/** Opens the editor that fits the column's type in a cell. */
function startEdit(rowIndex: number, colIndex: number): void {
  const r = result!;
  const row = r.rows[rowIndex];
  const c = r.columns[colIndex];
  const td = cellAt(rowIndex, colIndex);
  if (!row || !c || !td || td.querySelector(".cell-input")) return;
  if (c.type === "checkbox") {
    commitValue(row, c, row.cells[c.id] !== true);
    td.replaceChildren(...cellContent(c, row));
    return;
  }

  const original = row.cells[c.id];
  let read: () => unknown;
  let focus: HTMLInputElement;
  td.classList.add("editing");

  if (c.type === "list") {
    // Chips for the items, and an input that adds one on Enter or comma.
    const items: unknown[] = Array.isArray(original) ? [...original] : isEmptyValue(original) ? [] : [original];
    const input = el("input", { class: "cell-input chip-input", list: `sugg-${colIndex}`, placeholder: items.length ? "" : "Add item…" });
    // Only the chips are redrawn: moving the input in the DOM would blur it and close the editor.
    const chips = el("span", { class: "chips" });
    const wrap = el("div", { class: "chip-editor" }, chips, input);
    wrap.onmousedown = (e) => {
      if (e.target !== input) e.preventDefault();
    };
    const draw = () => {
      chips.replaceChildren(
        ...items.map((x, i) => {
          const remove = el("span", { class: "chip-x", title: "Remove" }, "×");
          // mousedown, not click: keep the focus in the editor.
          remove.onmousedown = (e) => {
            e.preventDefault();
            items.splice(i, 1);
            draw();
          };
          return el("span", { class: "chip" }, display(x), remove);
        }),
      );
      input.placeholder = items.length ? "" : "Add item…";
    };
    const take = () => {
      const t = input.value.trim().replace(/,$/, "");
      if (t) items.push(t);
      input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === ",") && input.value.trim()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        take();
        draw();
      } else if (e.key === "Backspace" && input.value === "" && items.length) {
        items.pop();
        draw();
      }
    });
    read = () => {
      take();
      return items;
    };
    focus = input;
    td.replaceChildren(wrap);
    draw();
    input.focus();
  } else {
    let attrs: Record<string, string> = { class: "cell-input" };
    let value = editable(original);
    if (c.type === "number") attrs = { ...attrs, type: "number", step: "any" };
    else if (c.type === "date" || c.type === "datetime") {
      attrs = { ...attrs, type: c.type === "date" ? "date" : "datetime-local" };
      value = dateValue(original, c.type);
    } else if (c.type === "text") attrs = { ...attrs, list: `sugg-${colIndex}` };
    const input = el("input", { ...attrs, value });
    // Text stays text: "3" typed into a text column is the string "3".
    read = () => (c.type === "number" ? (input.value.trim() === "" ? null : Number(input.value)) : input.value);
    focus = input;
    td.replaceChildren(input);
    input.focus();
    if (c.type === "text" || c.type === "object") input.select();
  }

  editing = true;
  let done = false;
  const finish = (commit: boolean, move?: "down" | "right" | "left") => {
    if (done) return;
    done = true;
    editing = false;
    if (commit) {
      const next = read();
      const before = c.type === "date" || c.type === "datetime" ? dateValue(original, c.type) : original;
      if (JSON.stringify(next ?? null) !== JSON.stringify(before ?? null) && !(isEmptyValue(next) && isEmptyValue(before))) {
        // Objects are typed as YAML and read by the host.
        commitValue(row, c, next, c.type === "object");
        // The dialog takes the focus: no next cell to move to.
        if (editsSelection(row)) move = undefined;
      }
    }
    td.classList.remove("editing");
    td.replaceChildren(...cellContent(c, row));
    const target = move && nextEditable(rowIndex, colIndex, move);
    if (target) startEdit(...target);
    else if (renderPending) render();
  };
  focus.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true, "down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      finish(true, e.shiftKey ? "left" : "right");
    } else if (e.key === "Escape") {
      // Handled here: the same Escape must not also close an open panel.
      e.preventDefault();
      finish(false);
    }
  });
  focus.addEventListener("blur", () => finish(true));
}

function toggle(uri: string, rows: Row[], range: boolean): void {
  if (range && lastClicked) {
    const a = rows.findIndex((r) => r.uri === lastClicked);
    const b = rows.findIndex((r) => r.uri === uri);
    if (a >= 0 && b >= 0) {
      const on = !isSelected(uri);
      for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) setSelected(r.uri, on);
      lastClicked = uri;
      return;
    }
  }
  setSelected(uri, !isSelected(uri));
  lastClicked = uri;
}

function table(): HTMLElement {
  const r = result!;
  const rows = r.rows;
  if (rows.length === 0) {
    const why = indexing && !indexing.checking ? "Indexing the workspace…" : search ? "No file matches the search." : "No file matches the filters of this view.";
    return el("p", { class: "empty" }, why);
  }
  const sort = r.sort[0];
  const all = el("input", { type: "checkbox", title: "Select the rows on this page" });
  all.checked = rows.every((row) => isSelected(row.uri));
  all.onchange = () => {
    for (const row of rows) setSelected(row.uri, all.checked);
    render();
  };
  const head = el("tr", {}, el("th", { class: "check" }, all));
  for (const c of r.columns) {
    const sorted = sort && sort.property === c.id;
    const th = el("th", { title: `${c.id} — click to sort` }, el("span", { class: "th-label" }, c.label), ...(sorted ? [icon(sort.direction === "DESC" ? "arrowDown" : "arrowUp", "sort-arrow")] : []));
    th.onclick = () => ops({ op: "setView", index: r.viewIndex, key: "sort", value: nextSort(c.id) });
    head.append(th);
  }

  // Autocomplete: the values each editable column already holds.
  const lists = r.columns.map((c, ci) => el("datalist", { id: `sugg-${ci}` }, ...(c.suggestions ?? []).map((v) => el("option", { value: v }))));

  const body = el("tbody");
  rows.forEach((row, ri) => {
    const box = el("input", { type: "checkbox" });
    box.checked = isSelected(row.uri);
    box.onclick = (e) => {
      toggle(row.uri, rows, e.shiftKey);
      render();
    };
    const tr = el("tr", { class: isSelected(row.uri) ? "selected" : "", title: row.readOnly }, el("td", { class: "check" }, box));
    r.columns.forEach((c, ci) => {
      const td = el("td", { "data-r": String(ri), "data-c": String(ci) }, ...cellContent(c, row));
      if (c.id === "file.name" || c.id === "file.path" || c.id === "file.basename") {
        td.className = "file";
        td.onclick = () => send({ type: "open", uri: row.uri });
      } else if (c.editable && !row.readOnly) {
        td.className = `editable type-${c.type}`;
        td.onclick = () => startEdit(ri, ci);
      } else {
        td.className = "readonly";
      }
      tr.append(td);
    });
    body.append(tr);
  });
  return el("div", {}, ...lists, el("table", {}, el("thead", {}, head), body));
}

function pager(): HTMLElement {
  const r = result!;
  const from = r.matchCount === 0 ? 0 : r.page * r.pageSize + 1;
  const to = Math.min((r.page + 1) * r.pageSize, r.matchCount);
  const prev = iconButton("chevronLeft", undefined, () => setUi({ page: r.page - 1 }), "", "Previous page");
  prev.disabled = r.page === 0;
  const next = iconButton("chevronRight", undefined, () => setUi({ page: r.page + 1 }), "", "Next page");
  next.disabled = r.page >= r.pageCount - 1;
  const sizes = [25, 50, 100, 250, 500];
  if (!sizes.includes(r.pageSize)) sizes.push(r.pageSize);
  return el("div", { class: "pager" },
    el("span", { class: "count" }, `${from}–${to} of ${r.matchCount}`),
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
  renderPending = false;
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
  }
  if (error) parts.push(el("div", { class: "banner error" }, error));
  for (const e of result?.errors ?? []) parts.push(el("div", { class: "banner warn" }, e));
  if (notice) parts.push(el("div", { class: "banner info" }, notice));
  if (indexing && !indexing.checking) {
    parts.push(el("div", { class: "banner info" }, `Indexing ${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()} files…`));
  }
  if (result) {
    if (selectionCount() > 0) parts.push(bulkBar());
    parts.push(el("div", { class: "table-host" }, table()));
    if (result.pageCount > 1 || result.matchCount > 25) parts.push(pager());
  }
  app.replaceChildren(...parts);
  keepInView(app.querySelector<HTMLElement>(".popover"));

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

/** Moves a popover left or right so all of it is inside the window. */
function keepInView(pop: HTMLElement | null): void {
  if (!pop) return;
  const margin = 8;
  const rect = pop.getBoundingClientRect();
  let shift = 0;
  if (rect.right > window.innerWidth - margin) shift = window.innerWidth - margin - rect.right;
  if (rect.left + shift < margin) shift = margin - rect.left;
  if (shift) pop.style.transform = `translateX(${Math.round(shift)}px)`;
}

window.addEventListener("resize", () => keepInView(app.querySelector<HTMLElement>(".popover")));

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
      result = msg.result;
      indexing = msg.indexing;
      rescopeSelection(msg.result);
      error = undefined;
      reconcileDrafts(msg.result);
      if (editing) {
        renderPending = true;
        return;
      }
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

// The view menu closes on a click elsewhere and on Escape; arrows move through it.
// A popover closes on a click outside it and its button.
document.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement;
  if (viewMenuOpen && !target.closest(".view-switcher")) closeViewMenu();
  if (panel && !target.closest(".anchor")) closePanel();
});
// Escape closes an open panel, unless it is cancelling a cell edit or the view menu.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented && !viewMenuOpen && panel) closePanel();
});

document.addEventListener("keydown", (e) => {
  if (!viewMenuOpen) return;
  if (e.key === "Escape") {
    closeViewMenu();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...app.querySelectorAll<HTMLElement>(".view-item")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }
});

send({ type: "ready" });
