/** Turns a human label into an identifier usable in formulas ($Col_id). */
export function labelToIdent(label: string, { capitalize = false } = {}): string {
  let id = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = capitalize ? "Table" : "A";
  if (/^[0-9]/.test(id)) id = (capitalize ? "T" : "c") + id;
  if (capitalize) id = id[0].toUpperCase() + id.slice(1);
  return id.slice(0, 60);
}

/** Appends a numeric suffix until the identifier is unused. */
export function uniqueIdent(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((s) => s.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${base.endsWith("_") ? "" : "_"}${i}`;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
}

/** Next spreadsheet-style column label after the existing ones: A, B, ... Z, AA. */
export function nextColumnLetter(taken: Iterable<string>): string {
  const set = new Set(taken);
  for (let n = 0; ; n++) {
    let s = "";
    let x = n;
    do {
      s = String.fromCharCode(65 + (x % 26)) + s;
      x = Math.floor(x / 26) - 1;
    } while (x >= 0);
    if (!set.has(s)) return s;
  }
}

/** Position strictly between two neighbours (fractional ordering). */
export function between(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}
