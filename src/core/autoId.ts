// The next ID for a new note, when a property holds IDs like REQ-042.

const ID = /^(.*?)(\d+)$/;

/** The next ID after the highest, with the same prefix and at least the same width; undefined unless most values are IDs with one prefix. */
export function nextId(values: unknown[]): string | undefined {
  const present = values.filter((v) => typeof v === "string" || typeof v === "number").map(String).filter((s) => s.trim() !== "");
  if (present.length === 0) return undefined;
  const parsed = present.map((s) => ID.exec(s.trim())).filter((m): m is RegExpExecArray => m !== null);
  const prefixes = new Map<string, RegExpExecArray[]>();
  for (const m of parsed) prefixes.set(m[1]!, [...(prefixes.get(m[1]!) ?? []), m]);
  const [prefix, ids] = [...prefixes].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  // A prefix of letters makes it an ID, not just a number; most values must share it.
  if (prefix === undefined || !ids || !/[A-Za-z]/.test(prefix) || ids.length < present.length * 0.8) return undefined;
  const width = Math.max(...ids.map((m) => m[2]!.length));
  const next = Math.max(...ids.map((m) => Number(m[2]))) + 1;
  return `${prefix}${String(next).padStart(width, "0")}`;
}
