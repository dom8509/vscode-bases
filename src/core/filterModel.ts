// The filter editor's model, and its translation to and from the `filters`
// of a .base file. A condition the editor can show as property / operator /
// value becomes an expression like `status == "done"`; any other expression
// stays an expression and is edited as text. Shared by host and webview, so
// it must not depend on anything but plain TypeScript.

import type { Filter } from "./base";

export type Conjunction = "and" | "or" | "not";

export type Operator =
  | "is" | "isNot"
  | "contains" | "notContains"
  | "startsWith" | "endsWith"
  | "isEmpty" | "isNotEmpty"
  | "gt" | "ge" | "lt" | "le"
  | "hasTag" | "inFolder";

export type FilterNode =
  | { kind: "group"; conj: Conjunction; children: FilterNode[] }
  | { kind: "cond"; property: string; op: Operator; value: string }
  | { kind: "expr"; expr: string };

export type FilterGroup = Extract<FilterNode, { kind: "group" }>;

export const OPERATORS: { op: Operator; label: string; needsValue: boolean; only?: string }[] = [
  { op: "is", label: "is", needsValue: true },
  { op: "isNot", label: "is not", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "notContains", label: "does not contain", needsValue: true },
  { op: "startsWith", label: "starts with", needsValue: true },
  { op: "endsWith", label: "ends with", needsValue: true },
  { op: "isEmpty", label: "is empty", needsValue: false },
  { op: "isNotEmpty", label: "is not empty", needsValue: false },
  { op: "gt", label: ">", needsValue: true },
  { op: "ge", label: "≥", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "le", label: "≤", needsValue: true },
  { op: "hasTag", label: "has tag", needsValue: true, only: "file.tags" },
  { op: "inFolder", label: "is in folder", needsValue: true, only: "file.folder" },
];

export const CONJUNCTIONS: { conj: Conjunction; label: string }[] = [
  { conj: "and", label: "All the following are true" },
  { conj: "or", label: "Any of the following are true" },
  { conj: "not", label: "None of the following are true" },
];

const COMPARISON: Partial<Record<Operator, string>> = { is: "==", isNot: "!=", gt: ">", ge: ">=", lt: "<", le: "<=" };
const METHOD: Partial<Record<Operator, string>> = { contains: "contains", startsWith: "startsWith", endsWith: "endsWith" };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How a property id is written in an expression: `status`, `note["due-date"]`, `file.name`, `formula.x`. */
export function propertyExpr(id: string): string {
  if (/^(file|formula)\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) return id;
  const name = id.startsWith("note.") ? id.slice(5) : id;
  return IDENT.test(name) && !["file", "note", "formula", "this", "true", "false", "null"].includes(name) ? name : `note[${JSON.stringify(name)}]`;
}

/** What a typed value becomes in an expression: numbers and booleans as they are, everything else a string. */
export function valueExpr(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) || v === "true" || v === "false") return v;
  return JSON.stringify(value);
}

export function conditionExpr(c: { property: string; op: Operator; value: string }): string {
  const p = propertyExpr(c.property);
  const v = valueExpr(c.value);
  const cmp = COMPARISON[c.op];
  if (cmp) return `${p} ${cmp} ${v}`;
  const method = METHOD[c.op];
  if (method) return `${p}.${method}(${v})`;
  switch (c.op) {
    case "notContains": return `!${p}.contains(${v})`;
    case "isEmpty": return `${p}.isEmpty()`;
    case "isNotEmpty": return `!${p}.isEmpty()`;
    case "hasTag": return `file.hasTag(${JSON.stringify(c.value.trim().replace(/^#/, ""))})`;
    case "inFolder": return `file.inFolder(${JSON.stringify(c.value.trim())})`;
    default: return "true";
  }
}

// --- reading expressions back -------------------------------------------------

const PROP = String.raw`(file\.[A-Za-z_$][\w$]*|formula\.[A-Za-z_$][\w$]*|note\["(?:[^"\\]|\\.)*"\]|note\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)`;
const VALUE = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)`;

function readProperty(src: string): string {
  if (src.startsWith('note["')) return JSON.parse(src.slice(5, -1)) as string;
  if (src.startsWith("note.")) return src.slice(5);
  return src;
}

function readValue(src: string): string {
  if (src.startsWith('"')) return JSON.parse(src) as string;
  if (src.startsWith("'")) return src.slice(1, -1).replace(/\\(.)/g, "$1");
  return src;
}

const PATTERNS: [RegExp, (m: RegExpExecArray) => { property: string; op: Operator; value: string } | undefined][] = [
  [new RegExp(String.raw`^file\.hasTag\(${VALUE}\)$`), (m) => ({ property: "file.tags", op: "hasTag", value: readValue(m[1]!) })],
  [new RegExp(String.raw`^file\.inFolder\(${VALUE}\)$`), (m) => ({ property: "file.folder", op: "inFolder", value: readValue(m[1]!) })],
  [new RegExp(String.raw`^(!?)${PROP}\.isEmpty\(\)$`), (m) => ({ property: readProperty(m[2]!), op: m[1] ? "isNotEmpty" : "isEmpty", value: "" })],
  [new RegExp(String.raw`^(!?)${PROP}\.(contains|startsWith|endsWith)\(${VALUE}\)$`), (m) => {
    const negated = Boolean(m[1]);
    if (negated && m[3] !== "contains") return undefined;
    const op: Operator = negated ? "notContains" : (m[3] as Operator);
    return { property: readProperty(m[2]!), op, value: readValue(m[4]!) };
  }],
  [new RegExp(String.raw`^${PROP}\s*(==|!=|>=|<=|>|<)\s*${VALUE}$`), (m) => {
    const op = (Object.keys(COMPARISON) as Operator[]).find((k) => COMPARISON[k] === m[2])!;
    return { property: readProperty(m[1]!), op, value: readValue(m[3]!) };
  }],
];

/** Reads an expression as a condition when the editor can show it as one. */
export function parseCondition(expr: string): FilterNode {
  const src = expr.trim();
  for (const [re, build] of PATTERNS) {
    const m = re.exec(src);
    const cond = m && build(m);
    // Only when writing the condition back gives the same meaning; quoting may differ.
    if (cond && canonical(conditionExpr(cond)) === canonical(src)) return { kind: "cond", ...cond };
  }
  return { kind: "expr", expr };
}

/** Spelling differences that do not change meaning: quotes, spaces, a `note.` prefix. */
function canonical(src: string): string {
  return src
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, s: string) => JSON.stringify(s.replace(/\\(.)/g, "$1")))
    .replace(/^(!?)note\.(?=[A-Za-z_$])/, "$1")
    .replace(/\s+/g, "");
}

export function toModel(filter: Filter | undefined | null): FilterGroup {
  if (filter === undefined || filter === null) return { kind: "group", conj: "and", children: [] };
  const node = toNode(filter);
  return node.kind === "group" ? node : { kind: "group", conj: "and", children: [node] };
}

function toNode(filter: Filter): FilterNode {
  if (typeof filter === "string") return parseCondition(filter);
  if (typeof filter === "object" && filter !== null) {
    for (const conj of ["and", "or", "not"] as const) {
      if (conj in filter) {
        const list = (filter as Record<string, unknown>)[conj];
        return { kind: "group", conj, children: (Array.isArray(list) ? list : []).map((f) => toNode(f as Filter)) };
      }
    }
  }
  return { kind: "expr", expr: String(filter) };
}

/** The `filters` value for a model; undefined when there is nothing to filter. */
export function fromModel(group: FilterGroup): Filter | undefined {
  const out = fromNode(group);
  return out === undefined ? undefined : out;
}

function fromNode(node: FilterNode): Filter | undefined {
  switch (node.kind) {
    case "cond":
      // A condition still waiting for its value filters nothing yet.
      if (OPERATORS.find((o) => o.op === node.op)?.needsValue && node.value.trim() === "") return undefined;
      return conditionExpr(node);
    case "expr": return node.expr.trim() === "" ? undefined : node.expr.trim();
    case "group": {
      const children = node.children.map(fromNode).filter((f): f is Filter => f !== undefined);
      if (children.length === 0) return undefined;
      return { [node.conj]: children } as Filter;
    }
  }
}
