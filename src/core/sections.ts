// Parts of a note's text, for file.section(...) and file.codeblock(...): the
// text under a heading, and the content of a fenced code block.

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
  const all = lines(body);
  const start = all.findIndex((l) => l.level !== undefined && l.title!.toLowerCase() === want.title.toLowerCase() && (want.level === undefined || l.level === want.level));
  if (start < 0) return undefined;
  const level = all[start]!.level!;
  let end = start + 1;
  while (end < all.length && (all[end]!.level === undefined || all[end]!.level! > level)) end++;
  return all.slice(start + 1, end).map((l) => l.text).join("\n").trim();
}

/**
 * The content of the first fenced code block whose language is `lang`
 * (any block when `lang` is empty), without the fences; undefined when there
 * is none. With a heading, only the text under that heading is searched.
 */
export function codeblock(body: string, lang: string, heading?: string): string | undefined {
  const text = heading === undefined || heading === "" ? body : section(body, heading);
  if (text === undefined) return undefined;
  const want = lang.trim().toLowerCase();
  const all = text.split(/\r?\n/);
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
    if (want === "" || info === want) return all.slice(i + 1, j).join("\n");
    i = j;
  }
  return undefined;
}
