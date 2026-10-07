// Reads a .base file and computes one of its views from the indexed records:
// filter, formulas, columns, sort and limit.

import { parse } from "yaml";
import { compare, ExprError, run, toDate, truthy, type EvalContext, type FileInfo } from "./expr";
import type { FileRecord } from "./record";

export type Filter = string | { and: Filter[] } | { or: Filter[] } | { not: Filter[] };

export interface SortSpec {
  property: string;
  direction: "ASC" | "DESC";
}

export interface ViewConfig {
  type: string;
  name: string;
  filters?: Filter;
  order?: string[];
  sort?: SortSpec[];
  limit?: number;
}

export interface BaseConfig {
  filters?: Filter;
  formulas: Record<string, string>;
  properties: Record<string, { displayName?: string }>;
  views: ViewConfig[];
}

export function parseBase(text: string): BaseConfig {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("A base must be a YAML mapping");
  const views = Array.isArray(raw.views) && raw.views.length > 0 ? (raw.views as ViewConfig[]) : [{ type: "table", name: "Table" }];
  return {
    filters: raw.filters as Filter | undefined,
    formulas: (raw.formulas ?? {}) as Record<string, string>,
    properties: (raw.properties ?? {}) as Record<string, { displayName?: string }>,
    views: views.map((v, i) => ({ ...v, type: v.type ?? "table", name: v.name ?? `View ${i + 1}` })),
  };
}

/** A property id as it appears in `order` and `sort`: `file.name`, `note.status`, `formula.x` or bare `status`. */
export interface PropertyRef {
  id: string;
  ns: "file" | "note" | "formula";
  name: string;
}

export function propertyRef(id: string): PropertyRef {
  const m = /^(file|note|formula)\.(.+)$/.exec(id);
  if (m) return { id: m[1] === "note" ? m[2]! : id, ns: m[1] as PropertyRef["ns"], name: m[2]! };
  return { id, ns: "note", name: id };
}

export interface Column {
  id: string;
  label: string;
  editable: boolean;
}

export interface Row {
  uri: string;
  path: string;
  readOnly?: string;
  cells: Record<string, unknown>;
}

export interface ViewResult {
  views: { name: string; type: string }[];
  viewIndex: number;
  columns: Column[];
  rows: Row[];
  total: number;
  sort: SortSpec[];
  /** Note properties seen in the filtered rows, for the bulk-edit picker. */
  propertyNames: string[];
  errors: string[];
}

function context(rec: FileRecord, base: BaseConfig, now: Date, thisFile: FileInfo | undefined, errors: Set<string>): EvalContext {
  const formulaCache = new Map<string, unknown>();
  const evaluating = new Set<string>();
  const ctx: EvalContext = {
    file: rec.file,
    note: rec.properties,
    tags: rec.tags,
    now,
    thisFile,
    formula: (name) => {
      if (formulaCache.has(name)) return formulaCache.get(name);
      const src = base.formulas[name];
      if (src === undefined) throw new ExprError(`Unknown formula: ${name}`);
      if (evaluating.has(name)) throw new ExprError(`Formula ${name} refers to itself`);
      evaluating.add(name);
      let value: unknown = null;
      try {
        value = run(String(src), ctx);
      } catch (e) {
        errors.add(`formula.${name}: ${(e as Error).message}`);
      } finally {
        evaluating.delete(name);
      }
      formulaCache.set(name, value);
      return value;
    },
  };
  return ctx;
}

function matches(filter: Filter | undefined, ctx: EvalContext, errors: Set<string>): boolean {
  if (filter === undefined || filter === null) return true;
  if (typeof filter === "string") {
    try {
      return truthy(run(filter, ctx));
    } catch (e) {
      errors.add(`${filter}: ${(e as Error).message}`);
      return false;
    }
  }
  if ("and" in filter) return (filter.and ?? []).every((f) => matches(f, ctx, errors));
  if ("or" in filter) return (filter.or ?? []).some((f) => matches(f, ctx, errors));
  if ("not" in filter) return !(filter.not ?? []).some((f) => matches(f, ctx, errors));
  errors.add(`Unknown filter: ${JSON.stringify(filter)}`);
  return false;
}

function cellValue(ref: PropertyRef, ctx: EvalContext): unknown {
  switch (ref.ns) {
    case "note": return ctx.note[ref.name];
    case "formula": return ctx.formula(ref.name);
    case "file": return run(`file.${ref.name}`, ctx);
  }
}

/** Makes a value safe to post to the webview. */
function serialize(v: unknown): unknown {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const hasTime = v.getHours() !== 0 || v.getMinutes() !== 0 || v.getSeconds() !== 0;
    const iso = new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString();
    return hasTime ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
  }
  if (Array.isArray(v)) return v.map(serialize);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serialize(x)]));
  if (typeof v === "function") return null;
  return v;
}

export interface ComputeOptions {
  viewIndex: number;
  now?: Date;
  thisFile?: FileInfo;
}

export function computeView(base: BaseConfig, records: Iterable<FileRecord>, opts: ComputeOptions): ViewResult {
  const viewIndex = Math.min(Math.max(opts.viewIndex, 0), base.views.length - 1);
  const view = base.views[viewIndex]!;
  const now = opts.now ?? new Date();
  const errors = new Set<string>();

  const hits: { rec: FileRecord; ctx: EvalContext }[] = [];
  for (const rec of records) {
    const ctx = context(rec, base, now, opts.thisFile, errors);
    if (matches(base.filters, ctx, errors) && matches(view.filters, ctx, errors)) hits.push({ rec, ctx });
  }

  // Without an explicit order: the file name, then every note property by how often it occurs.
  const counts = new Map<string, number>();
  for (const { rec } of hits) for (const k of Object.keys(rec.properties)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const propertyNames = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  const order = view.order && view.order.length > 0 ? view.order : ["file.name", ...propertyNames];
  const refs = order.map(propertyRef);

  const sort = (view.sort ?? []).filter((s) => s && s.property);
  const sortRefs = sort.map((s) => ({ ref: propertyRef(s.property), desc: String(s.direction).toUpperCase() === "DESC" }));
  const keyed = hits.map((h) => ({
    ...h,
    keys: sortRefs.map(({ ref }) => {
      const v = cellValue(ref, h.ctx);
      return ref.ns === "note" && typeof v === "string" && toDate(v) && /^\d{4}-\d\d-\d\d/.test(v) ? toDate(v) : v;
    }),
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < sortRefs.length; i++) {
      const x = a.keys[i];
      const y = b.keys[i];
      // Empty values go last in either direction.
      const xe = x === null || x === undefined || x === "";
      const ye = y === null || y === undefined || y === "";
      if (xe !== ye) return xe ? 1 : -1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return sortRefs[i]!.desc ? -c : c;
    }
    return a.rec.file.path.localeCompare(b.rec.file.path);
  });

  const limited = typeof view.limit === "number" && view.limit > 0 ? keyed.slice(0, view.limit) : keyed;

  const columns: Column[] = refs.map((ref) => ({
    id: ref.id,
    label: base.properties[ref.id]?.displayName ?? base.properties[`note.${ref.id}`]?.displayName ?? ref.name,
    editable: ref.ns === "note",
  }));

  const rows: Row[] = limited.map(({ rec, ctx }) => {
    const cells: Record<string, unknown> = {};
    for (const ref of refs) {
      try {
        cells[ref.id] = serialize(cellValue(ref, ctx));
      } catch (e) {
        errors.add(`${ref.id}: ${(e as Error).message}`);
        cells[ref.id] = null;
      }
    }
    return { uri: rec.uri, path: rec.file.path, readOnly: rec.readOnly, cells };
  });

  return {
    views: base.views.map((v) => ({ name: v.name, type: v.type })),
    viewIndex,
    columns,
    rows,
    total: hits.length,
    sort,
    propertyNames,
    errors: [...errors],
  };
}
