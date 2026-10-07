// Reads a .base file and computes one of its views from the indexed records:
// filter, formulas, columns, sort and limit.

import { parse } from "yaml";
import { compare, ExprError, run, toDate, truthy, type EvalContext, type FileInfo } from "./expr";
import { toModel, type FilterGroup } from "./filterModel";
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

export interface PropertyInfo {
  id: string;
  label: string;
  ns: PropertyRef["ns"];
}

export interface ViewResult {
  views: { name: string; type: string }[];
  viewIndex: number;
  /** The selected view as written in the base. */
  view: { name: string; order: string[]; sort: SortSpec[]; limit?: number };
  baseFilter: FilterGroup;
  viewFilter: FilterGroup;
  /** The filters as written in the file, to tell whether an edit in progress is still current. */
  rawFilters: { base: Filter | null; view: Filter | null };
  formulas: Record<string, string>;
  columns: Column[];
  /** The rows of the current page. */
  rows: Row[];
  /** Every file the view and the search match, across all pages: for "select all". */
  allUris: string[];
  /** Files the filters match, before limit and search. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  sort: SortSpec[];
  /** Note properties seen in the indexed files, for the bulk-edit picker. */
  propertyNames: string[];
  /** Every property a column, sort or filter can use. */
  properties: PropertyInfo[];
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
  /** Zero-based page. */
  page?: number;
  pageSize?: number;
  /** Free-text search over the cells of the view's columns. */
  query?: string;
  now?: Date;
  thisFile?: FileInfo;
}

export const DEFAULT_PAGE_SIZE = 50;

const FILE_PROPERTIES = ["name", "basename", "path", "folder", "ext", "size", "mtime", "ctime", "tags"];

function label(base: BaseConfig, ref: PropertyRef): string {
  return base.properties[ref.id]?.displayName ?? base.properties[`note.${ref.id}`]?.displayName ?? ref.name;
}

function displayText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(displayText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function computeView(base: BaseConfig, records: Iterable<FileRecord>, opts: ComputeOptions): ViewResult {
  const viewIndex = Math.min(Math.max(opts.viewIndex, 0), base.views.length - 1);
  const view = base.views[viewIndex]!;
  const now = opts.now ?? new Date();
  const errors = new Set<string>();

  const all = [...records];
  const hits: { rec: FileRecord; ctx: EvalContext }[] = [];
  for (const rec of all) {
    const ctx = context(rec, base, now, opts.thisFile, errors);
    if (matches(base.filters, ctx, errors) && matches(view.filters, ctx, errors)) hits.push({ rec, ctx });
  }

  // Note properties across the workspace, the most common first.
  const counts = new Map<string, number>();
  for (const rec of all) for (const k of Object.keys(rec.properties)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const propertyNames = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));

  // A view without columns lists its files by name.
  const order = Array.isArray(view.order) && view.order.length > 0 ? view.order.map(String) : ["file.name"];
  const refs = order.map(propertyRef);

  const sort = (Array.isArray(view.sort) ? view.sort : []).filter((s) => s && s.property);
  const sortRefs = sort.map((s) => ({ ref: propertyRef(s.property), desc: String(s.direction).toUpperCase() === "DESC" }));
  const keyed = hits.map((h) => ({
    ...h,
    keys: sortRefs.map(({ ref }) => {
      let v: unknown;
      try {
        v = cellValue(ref, h.ctx);
      } catch (e) {
        errors.add(`${ref.id}: ${(e as Error).message}`);
      }
      return ref.ns === "note" && typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v) ? toDate(v) : v;
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

  const cellsOf = (ctx: EvalContext): Record<string, unknown> => {
    const cells: Record<string, unknown> = {};
    for (const ref of refs) {
      try {
        cells[ref.id] = serialize(cellValue(ref, ctx));
      } catch (e) {
        errors.add(`${ref.id}: ${(e as Error).message}`);
        cells[ref.id] = null;
      }
    }
    return cells;
  };

  // Search needs every row's cells; without a search only the page's are computed.
  const query = (opts.query ?? "").trim().toLowerCase();
  let found: { rec: FileRecord; ctx: EvalContext; cells?: Record<string, unknown> }[] = limited;
  if (query) {
    found = limited
      .map((h) => ({ ...h, cells: cellsOf(h.ctx) }))
      .filter((h) => h.rec.file.path.toLowerCase().includes(query) || Object.values(h.cells).some((v) => displayText(v).toLowerCase().includes(query)));
  }

  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(found.length / pageSize));
  const page = Math.min(Math.max(opts.page ?? 0, 0), pageCount - 1);
  const rows: Row[] = found.slice(page * pageSize, (page + 1) * pageSize).map((h) => ({
    uri: h.rec.uri,
    path: h.rec.file.path,
    readOnly: h.rec.readOnly,
    cells: h.cells ?? cellsOf(h.ctx),
  }));

  const columns: Column[] = refs.map((ref) => ({ id: ref.id, label: label(base, ref), editable: ref.ns === "note" }));
  const properties: PropertyInfo[] = [
    ...FILE_PROPERTIES.map((n) => propertyRef(`file.${n}`)),
    ...propertyNames.map(propertyRef),
    ...Object.keys(base.formulas).map((n) => propertyRef(`formula.${n}`)),
  ].map((ref) => ({ id: ref.id, label: label(base, ref), ns: ref.ns }));

  return {
    views: base.views.map((v) => ({ name: v.name, type: v.type })),
    viewIndex,
    view: { name: view.name, order, sort, limit: typeof view.limit === "number" ? view.limit : undefined },
    baseFilter: toModel(base.filters),
    viewFilter: toModel(view.filters),
    rawFilters: { base: base.filters ?? null, view: view.filters ?? null },
    formulas: Object.fromEntries(Object.entries(base.formulas).map(([k, v]) => [k, String(v)])),
    columns,
    rows,
    allUris: found.map((h) => h.rec.uri),
    total: hits.length,
    page,
    pageSize,
    pageCount,
    sort,
    propertyNames,
    properties,
    errors: [...errors],
  };
}
