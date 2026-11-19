// A small Markdown renderer for automation emails. Pure TypeScript (no Deno
// or Node APIs), so the app's unit tests can run it too.
//
// Supported: # headings, - and 1. lists, **bold**, *italic* / _italic_,
// `code`, [text](https://…) and bare links, paragraphs and line breaks.
//
// Values from records arrive with their Markdown characters backslash-escaped
// (the database does that), so a cell can never add formatting or a link of
// its own. Everything is HTML-escaped before any tag is added.

const ESCAPABLE = /\\([\\`*_[\]()#>~|])/g;

const HTML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => HTML[c]);
}

/** The text as it should read in a plain-text email: backslash escapes removed. */
export function plainText(md: string): string {
  return md.replace(ESCAPABLE, "$1");
}

/** Markdown to HTML (a fragment: paragraphs, lists and headings). */
export function renderHtml(md: string): string {
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  let s = md.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  // Escaped characters are literal text from here on.
  s = s.replace(ESCAPABLE, (_m, c: string) => keep(escapeHtml(c)));
  s = escapeHtml(s);
  // Links first, so their addresses aren't read as emphasis.
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_m, text: string, url: string) => keep(`<a href="${url}">`) + text + keep("</a>"));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])/g, (_m, pre: string, url: string) => pre + keep(`<a href="${url}">${url}</a>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${code}</code>`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*\n]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\s][^_\n]*)_(?!\w)/g, "$1<em>$2</em>");

  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of s.split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      const level = heading[1].length + 1; // "#" is an h2 inside an email
      out.push(`<h${level}>${heading[2]}</h${level}>`);
    } else if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (para.length || (list && list.tag !== tag)) flush();
      list = list ?? { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  let html = out.join("\n");
  // Put the kept pieces back (twice: link text may hold escaped characters).
  for (let pass = 0; pass < 2; pass++) html = html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
  return html;
}
