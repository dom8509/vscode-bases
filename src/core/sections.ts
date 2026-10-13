// Parts of a note's text, for file.section(...): a path from heading to
// heading, ending in a heading or a fenced code block, written
// "Text > Details > ```text".

interface Line {
  text: string;
  /** Heading level 1–6, when the line is a heading outside a code block. */
  level?: number;
  /** The heading's title, when the line is a heading. */
  title?: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/** The lines of a text, with headings marked; lines inside code blocks are never headings. */
function lines(body: string): Line[] {
  const out: Line[] = [];
  let fence: string | undefined;
  for (const text of body.split(/\r?\n/)) {
    const f = FENCE.exec(text);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && f[2]!.trim() === "") fence = undefined;
      out.push({ text });
    } else if (f) {
      fence = f[1]!;
      out.push({ text });
    } else {
      const h = HEADING.exec(text);
      out.push(h ? { text, level: h[1]!.length, title: (h[2] ?? "").trim() } : { text });
    }
  }
  return out;
}

/** "Text" or "## Text": the title, and the level when it is written. */
function headingQuery(heading: string): { title: string; level?: number } {
  const m = /^\s*(#{1,6})\s+(.*)$/.exec(heading);
  return m ? { title: m[2]!.trim(), level: m[1]!.length } : { title: heading.trim() };
}

/**
 * The text under a heading, up to the next heading of the same or a higher
 * level, without the heading itself; undefined when the note has no such
 * heading. The title is matched without case; "## Text" also matches the level.
 */
export function section(body: string, heading: string): string | undefined {
  const want = headingQuery(heading);
  if (want.title === "") return undefined;
  const all = lines(body);
  const start = all.findIndex((l) => l.level !== undefined && l.title!.toLowerCase() === want.title.toLowerCase() && (want.level === undefined || l.level === want.level));
  if (start < 0) return undefined;
  const level = all[start]!.level!;
  let end = start + 1;
  while (end < all.length && (all[end]!.level === undefined || all[end]!.level! > level)) end++;
  return all.slice(start + 1, end).map((l) => l.text).join("\n").trim();
}

/**
 * The content of the `index`th (from 1) fenced code block whose language is
 * `lang` (any block when `lang` is empty), without the fences; undefined when
 * there is none.
 */
export function codeblock(text: string, lang: string, index = 1): string | undefined {
  const want = lang.trim().toLowerCase();
  const all = text.split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < all.length; i++) {
    const open = FENCE.exec(all[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const info = open[2]!.trim().split(/\s+/)[0]!.replace(/^\{\.?|\}$/g, "").toLowerCase();
    let j = i + 1;
    while (j < all.length) {
      const close = FENCE.exec(all[j]!);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && close[2]!.trim() === "") break;
      j++;
    }
    if ((want === "" || info === want) && ++seen === index) return all.slice(i + 1, j).join("\n");
    i = j;
  }
  return undefined;
}

/** One step of a section path: a heading, or a code block that ends the path. */
export type PathStep =
  | { kind: "heading"; title: string; level?: number }
  | { kind: "code"; lang: string; index: number };

/**
 * Reads a path: steps separated by ">" ("\>" is a ">" in a heading). A step
 * is a heading ("Text" or "## Text"), each looked for under the one before,
 * or, as the last step, a code block: "```text", "```" for any language, and
 * "```text[2]" for the second one.
 */
export function parsePath(path: string): PathStep[] {
  const raw = path.split(/(?<!\\)>/).map((s) => s.replace(/\\>/g, ">").trim());
  if (raw.some((s) => s === "")) throw new Error("A step of the path is empty");
  return raw.map((step, i) => {
    const code = /^(`{3,}|~{3,})\s*([^\s[\]]*)\s*(?:\[(\d+)\])?$/.exec(step);
    if (!code) return { kind: "heading" as const, ...headingQuery(step) };
    if (i !== raw.length - 1) throw new Error("A code block ends the path");
    const index = code[3] === undefined ? 1 : Number(code[3]);
    if (index < 1) throw new Error("Code blocks count from 1");
    return { kind: "code" as const, lang: code[2]!.toLowerCase(), index };
  });
}

/** The part of a note a path names; undefined when the note has none. */
export function sectionPath(body: string, path: string): string | undefined {
  let text: string | undefined = body;
  for (const step of parsePath(path)) {
    if (text === undefined) return undefined;
    text = step.kind === "heading" ? section(text, step.level ? `${"#".repeat(step.level)} ${step.title}` : step.title) : codeblock(text, step.lang, step.index);
  }
  return text;
}

/** A path as a column name: "Text › Details › text block". */
export function pathLabel(path: string): string {
  try {
    return parsePath(path).map((s) => (s.kind === "heading" ? s.title : `${s.lang || "code"} block${s.index > 1 ? ` ${s.index}` : ""}`)).join(" › ");
  } catch {
    return path;
  }
}

/** The path of a file.section("...") column; undefined for any other column. */
export function sectionArg(id: string): string | undefined {
  const m = /^file\.section\((.*)\)$/s.exec(id);
  if (!m) return undefined;
  try {
    const arg: unknown = JSON.parse(m[1]!);
    return typeof arg === "string" ? arg : undefined;
  } catch {
    return undefined;
  }
}

/** The id of the column that shows a path: file.section("Text > ```text"). */
export function sectionId(path: string): string {
  return `file.section(${JSON.stringify(path)})`;
}
