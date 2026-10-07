// A subset of the Obsidian Bases expression language: literals, property
// access, arithmetic, comparison, boolean logic, and the common functions and
// methods. Anything outside the subset raises an ExprError naming it, so a base
// that uses it shows what is missing instead of silently matching nothing.

export class ExprError extends Error {}

type Node =
  | { t: "lit"; v: unknown }
  | { t: "list"; items: Node[] }
  | { t: "id"; name: string }
  | { t: "member"; obj: Node; name: string }
  | { t: "index"; obj: Node; index: Node }
  | { t: "call"; callee: Node; args: Node[] }
  | { t: "unary"; op: string; arg: Node }
  | { t: "binary"; op: string; left: Node; right: Node };

type Token = { k: "num" | "str" | "id" | "op" | "eof"; v: string; pos: number };

const OPERATORS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "."];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ k: "num", v: m[0], pos: i });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprError(`Unterminated string at ${i}`);
      tokens.push({ k: "str", v: s, pos: i });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      tokens.push({ k: "id", v: m[0], pos: i });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (!op) throw new ExprError(`Unexpected '${c}' at ${i}`);
      tokens.push({ k: "op", v: op, pos: i });
      i += op.length;
    }
  }
  tokens.push({ k: "eof", v: "", pos: src.length });
  return tokens;
}

export function parseExpr(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p]!;
  const next = () => tokens[p++]!;
  const isOp = (v: string) => peek().k === "op" && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected '${v}' at ${peek().pos}`);
    next();
  };

  const binary = (ops: string[], sub: () => Node) => (): Node => {
    let left = sub();
    while (peek().k === "op" && ops.includes(peek().v)) {
      const op = next().v;
      left = { t: "binary", op, left, right: sub() };
    }
    return left;
  };

  const args = (close: string): Node[] => {
    const out: Node[] = [];
    if (!isOp(close)) {
      do out.push(or());
      while (isOp(",") && next());
    }
    expect(close);
    return out;
  };

  const primary = (): Node => {
    const tok = next();
    if (tok.k === "num") return { t: "lit", v: Number(tok.v) };
    if (tok.k === "str") return { t: "lit", v: tok.v };
    if (tok.k === "id") {
      if (tok.v === "true") return { t: "lit", v: true };
      if (tok.v === "false") return { t: "lit", v: false };
      if (tok.v === "null") return { t: "lit", v: null };
      return { t: "id", name: tok.v };
    }
    if (tok.k === "op" && tok.v === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (tok.k === "op" && tok.v === "[") return { t: "list", items: args("]") };
    throw new ExprError(tok.k === "eof" ? "Unexpected end of expression" : `Unexpected '${tok.v}' at ${tok.pos}`);
  };

  const postfix = (): Node => {
    let node = primary();
    for (;;) {
      if (isOp(".")) {
        next();
        const name = next();
        if (name.k !== "id") throw new ExprError(`Expected a name after '.' at ${name.pos}`);
        node = { t: "member", obj: node, name: name.v };
      } else if (isOp("[")) {
        next();
        const index = or();
        expect("]");
        node = { t: "index", obj: node, index };
      } else if (isOp("(")) {
        next();
        node = { t: "call", callee: node, args: args(")") };
      } else {
        return node;
      }
    }
  };

  const unary = (): Node => {
    if (isOp("!") || isOp("-")) {
      const op = next().v;
      return { t: "unary", op, arg: unary() };
    }
    return postfix();
  };

  const mul = binary(["*", "/", "%"], unary);
  const add = binary(["+", "-"], mul);
  const cmp = binary(["==", "!=", ">=", "<=", ">", "<"], add);
  const and = binary(["&&"], cmp);
  const or = binary(["||"], and);

  const root = or();
  if (peek().k !== "eof") throw new ExprError(`Unexpected '${peek().v}' at ${peek().pos}`);
  return root;
}

// --- evaluation -------------------------------------------------------------

export interface FileInfo {
  /** Workspace-relative path with forward slashes. */
  path: string;
  /** File name with extension. */
  name: string;
  /** File name without extension. */
  basename: string;
  ext: string;
  folder: string;
  mtime: number;
  ctime: number;
  size: number;
}

export interface EvalContext {
  file: FileInfo;
  note: Record<string, unknown>;
  tags: string[];
  formula: (name: string) => unknown;
  thisFile?: FileInfo;
  now: Date;
}

/** Function value produced by member access, so `x.contains` can be called. */
class Fn {
  constructor(readonly name: string, readonly impl: (args: unknown[]) => unknown) {}
}

/** Marker objects for the `file`, `note`, `formula` and `this` namespaces. */
class Namespace {
  constructor(readonly kind: "file" | "note" | "formula" | "this") {}
}

export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && !(v instanceof Date)) return Object.keys(v).length === 0;
  return false;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return Boolean(v);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "") return a === Number(b);
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "") return b === Number(a);
  return a === b;
}

/** Orders two values; undefined when they are not comparable. */
export function compare(a: unknown, b: unknown): number | undefined {
  if (a === null || a === undefined || b === null || b === undefined) return undefined;
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000, second: 1000, seconds: 1000,
  m: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  M: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000,
  y: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
};

function duration(s: string): number | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(s);
  if (!m) return undefined;
  const unit = DURATION_UNITS[m[2]!];
  return unit === undefined ? undefined : Number(m[1]) * unit;
}

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v.trim().replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function arith(op: string, a: unknown, b: unknown): unknown {
  if (a instanceof Date && (op === "+" || op === "-")) {
    if (typeof b === "string") {
      const ms = duration(b);
      if (ms === undefined) throw new ExprError(`Not a duration: "${b}"`);
      return new Date(a.getTime() + (op === "+" ? ms : -ms));
    }
    if (b instanceof Date && op === "-") return a.getTime() - b.getTime();
  }
  if (op === "+" && (typeof a === "string" || typeof b === "string")) return `${a ?? ""}${b ?? ""}`;
  if (op === "+" && Array.isArray(a)) return a.concat(b);
  const x = Number(a);
  const y = Number(b);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return x / y;
    default: return x % y;
  }
}

function asList(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function normTag(t: unknown): string {
  return String(t).replace(/^#/, "").toLowerCase();
}

function fileMember(file: FileInfo, ctx: EvalContext, name: string): unknown {
  switch (name) {
    case "name": case "basename": case "path": case "ext": case "folder": case "size":
      return file[name];
    case "mtime": return new Date(file.mtime);
    case "ctime": return new Date(file.ctime);
    case "tags": return ctx.tags;
    case "properties": return ctx.note;
    case "hasTag":
      return new Fn("file.hasTag", (tags) =>
        tags.some((t) => {
          const want = normTag(t);
          return ctx.tags.some((have) => have === want || have.startsWith(`${want}/`));
        }),
      );
    case "inFolder":
      return new Fn("file.inFolder", ([folder]) => {
        const f = String(folder ?? "").replace(/^\/+|\/+$/g, "");
        return f === "" || file.folder === f || file.folder.startsWith(`${f}/`);
      });
    case "hasProperty":
      return new Fn("file.hasProperty", ([p]) => Object.prototype.hasOwnProperty.call(ctx.note, String(p)));
    default:
      throw new ExprError(`Unsupported: file.${name}`);
  }
}

function method(target: unknown, name: string): Fn {
  const f = (impl: (args: unknown[]) => unknown) => new Fn(name, impl);
  // Methods every value has.
  switch (name) {
    case "isEmpty": return f(() => isEmpty(target));
    case "isTruthy": return f(() => truthy(target));
    case "toString": return f(() => (target === null || target === undefined ? "" : String(target)));
    case "isType":
      return f(([type]) => {
        const actual = Array.isArray(target) ? "list" : target instanceof Date ? "date" : target === null || target === undefined ? "null" : typeof target === "object" ? "object" : typeof target;
        return actual === type;
      });
  }
  if (Array.isArray(target)) {
    switch (name) {
      case "contains": return f(([x]) => target.some((y) => equal(x, y)));
      case "containsAll": return f((xs) => xs.every((x) => target.some((y) => equal(x, y))));
      case "containsAny": return f((xs) => xs.some((x) => target.some((y) => equal(x, y))));
      case "join": return f(([sep]) => target.join(sep === undefined ? ", " : String(sep)));
      case "unique": return f(() => target.filter((x, i) => target.findIndex((y) => equal(x, y)) === i));
      case "sort": return f(() => [...target].sort((a, b) => compare(a, b) ?? 0));
      case "reverse": return f(() => [...target].reverse());
      case "slice": return f(([a, b]) => target.slice(a as number, b as number | undefined));
    }
  }
  if (typeof target === "string") {
    switch (name) {
      case "contains": return f(([x]) => target.includes(String(x)));
      case "containsAll": return f((xs) => xs.every((x) => target.includes(String(x))));
      case "containsAny": return f((xs) => xs.some((x) => target.includes(String(x))));
      case "startsWith": return f(([x]) => target.startsWith(String(x)));
      case "endsWith": return f(([x]) => target.endsWith(String(x)));
      case "lower": return f(() => target.toLowerCase());
      case "upper": return f(() => target.toUpperCase());
      case "trim": return f(() => target.trim());
      case "replace": return f(([a, b]) => target.split(String(a)).join(String(b ?? "")));
      case "split": return f(([sep]) => target.split(String(sep)));
      case "slice": return f(([a, b]) => target.slice(a as number, b as number | undefined));
    }
  }
  if (typeof target === "number") {
    switch (name) {
      case "abs": return f(() => Math.abs(target));
      case "ceil": return f(() => Math.ceil(target));
      case "floor": return f(() => Math.floor(target));
      case "round":
        return f(([digits]) => {
          const k = 10 ** Number(digits ?? 0);
          return Math.round(target * k) / k;
        });
      case "toFixed": return f(([digits]) => target.toFixed(Number(digits ?? 0)));
    }
  }
  if (target instanceof Date) {
    switch (name) {
      case "date": return f(() => new Date(target.getFullYear(), target.getMonth(), target.getDate()));
      case "format": return f(([fmt]) => formatDate(target, String(fmt ?? "YYYY-MM-DD")));
    }
  }
  if (target === null || target === undefined) {
    // Methods on a missing property behave like on an empty value.
    switch (name) {
      case "contains": case "containsAll": case "containsAny": case "startsWith": case "endsWith":
        return f(() => false);
    }
  }
  throw new ExprError(`Unsupported method: ${name}() on ${Array.isArray(target) ? "list" : target === null || target === undefined ? "empty value" : typeof target}`);
}

function member(target: unknown, name: string): unknown {
  if (name === "length" && (typeof target === "string" || Array.isArray(target))) return target.length;
  if (target instanceof Date) {
    switch (name) {
      case "year": return target.getFullYear();
      case "month": return target.getMonth() + 1;
      case "day": return target.getDate();
      case "hour": return target.getHours();
      case "minute": return target.getMinutes();
    }
  }
  if (target !== null && typeof target === "object" && !Array.isArray(target) && !(target instanceof Date)) {
    if (Object.prototype.hasOwnProperty.call(target, name)) return (target as Record<string, unknown>)[name];
  }
  return method(target, name);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => {
    switch (t) {
      case "YYYY": return String(d.getFullYear());
      case "MM": return pad(d.getMonth() + 1);
      case "DD": return pad(d.getDate());
      case "HH": return pad(d.getHours());
      case "mm": return pad(d.getMinutes());
      default: return pad(d.getSeconds());
    }
  });
}

function globalFunction(name: string, ctx: EvalContext): Fn {
  const f = (impl: (args: unknown[]) => unknown) => new Fn(name, impl);
  switch (name) {
    case "if": return f(([c, a, b]) => (truthy(c) ? a : b ?? null));
    case "now": return f(() => ctx.now);
    case "today": return f(() => new Date(ctx.now.getFullYear(), ctx.now.getMonth(), ctx.now.getDate()));
    case "date": return f(([v]) => toDate(v));
    case "number": return f(([v]) => (v instanceof Date ? v.getTime() : typeof v === "boolean" ? Number(v) : Number(v)));
    case "list": return f(([v]) => asList(v));
    case "min": return f((xs) => xs.reduce((a, b) => ((compare(a, b) ?? 0) <= 0 ? a : b)));
    case "max": return f((xs) => xs.reduce((a, b) => ((compare(a, b) ?? 0) >= 0 ? a : b)));
    default: throw new ExprError(`Unsupported function: ${name}()`);
  }
}

function resolveId(name: string, ctx: EvalContext): unknown {
  switch (name) {
    case "file": return new Namespace("file");
    case "note": return new Namespace("note");
    case "formula": return new Namespace("formula");
    case "this": return new Namespace("this");
    default: return ctx.note[name];
  }
}

export function evaluate(node: Node, ctx: EvalContext): unknown {
  const ev = (n: Node): unknown => evaluate(n, ctx);
  switch (node.t) {
    case "lit": return node.v;
    case "list": return node.items.map(ev);
    case "id": return resolveId(node.name, ctx);
    case "member": {
      const obj = ev(node.obj);
      if (obj instanceof Namespace) {
        switch (obj.kind) {
          case "file": return fileMember(ctx.file, ctx, node.name);
          case "note": return ctx.note[node.name];
          case "formula": return ctx.formula(node.name);
          case "this":
            if (node.name !== "file" || !ctx.thisFile) throw new ExprError(`Unsupported: this.${node.name}`);
            return { ...ctx.thisFile, mtime: new Date(ctx.thisFile.mtime), ctime: new Date(ctx.thisFile.ctime) };
        }
      }
      return member(obj, node.name);
    }
    case "index": {
      const obj = ev(node.obj);
      const index = ev(node.index);
      if (obj instanceof Namespace && obj.kind === "note") return ctx.note[String(index)];
      if (Array.isArray(obj) || typeof obj === "string") return obj[Number(index) < 0 ? obj.length + Number(index) : Number(index)];
      if (obj !== null && typeof obj === "object") return (obj as Record<string, unknown>)[String(index)];
      return undefined;
    }
    case "call": {
      const fn = node.callee.t === "id" ? globalFunction(node.callee.name, ctx) : ev(node.callee);
      if (!(fn instanceof Fn)) throw new ExprError("Not a function");
      return fn.impl(node.args.map(ev));
    }
    case "unary": {
      const v = ev(node.arg);
      return node.op === "!" ? !truthy(v) : -Number(v);
    }
    case "binary": {
      if (node.op === "&&") return truthy(ev(node.left)) && truthy(ev(node.right));
      if (node.op === "||") return truthy(ev(node.left)) || truthy(ev(node.right));
      const a = ev(node.left);
      const b = ev(node.right);
      switch (node.op) {
        case "==": return equal(a, b);
        case "!=": return !equal(a, b);
        case ">": case "<": case ">=": case "<=": {
          // A date compared with anything else compares as a date.
          const c = a instanceof Date || b instanceof Date ? compare(toDate(a), toDate(b)) : compare(a, b);
          if (c === undefined) return false;
          return node.op === ">" ? c > 0 : node.op === "<" ? c < 0 : node.op === ">=" ? c >= 0 : c <= 0;
        }
        default: return arith(node.op, a, b);
      }
    }
  }
}

const cache = new Map<string, Node>();

/** Parses (cached) and evaluates an expression string. */
export function run(src: string, ctx: EvalContext): unknown {
  let node = cache.get(src);
  if (!node) {
    node = parseExpr(src);
    cache.set(src, node);
  }
  return evaluate(node, ctx);
}
