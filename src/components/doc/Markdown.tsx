"use client";

// A small, safe Markdown renderer for cells and cards: headings, lists,
// paragraphs, **bold**, *italic*, `code`, ~~strike~~ and [links](url).
// It builds React elements (never raw HTML), and only http(s) and mailto
// links are made clickable.
import type { ReactNode } from "react";

export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u)) return `https://${u}`;
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (tok.startsWith("~~")) out.push(<s key={k}>{inline(tok.slice(2, -2), k)}</s>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-gray-100 px-1 font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(mm[2]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline" onMouseDown={(e) => e.stopPropagation()}>
            {mm[1]}
          </a>
        ) : (
          mm[1]
        ),
      );
    } else if (/^https?:\/\//.test(tok)) {
      out.push(
        <a key={k} href={tok} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline" onMouseDown={(e) => e.stopPropagation()}>
          {tok}
        </a>,
      );
    } else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  const lines = text.replace(/\r/g, "").split("\n");
  if (compact) {
    // One line in a grid cell: drop block syntax, keep inline formatting.
    const first = lines.find((l) => l.trim()) ?? "";
    return <>{inline(first.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/, ""), "c")}</>;
  }
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      const k = `p${blocks.length}`;
      blocks.push(
        <p key={k} className="my-1">
          {para.flatMap((l, i) => (i ? [<br key={`${k}b${i}`} />, ...inline(l, `${k}-${i}`)] : inline(l, `${k}-${i}`)))}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const k = `l${blocks.length}`;
      const items = list.items.map((it, i) => <li key={i}>{inline(it, `${k}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={k} className="my-1 list-decimal pl-5">{items}</ol> : <ul key={k} className="my-1 list-disc pl-5">{items}</ul>);
      list = null;
    }
  };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const size = ["text-lg", "text-base", "text-sm", "text-sm", "text-sm", "text-sm"][h[1].length - 1];
      blocks.push(<div key={`h${blocks.length}`} className={`my-1 font-semibold ${size}`}>{inline(h[2], `h${blocks.length}`)}</div>);
    } else if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(li[2]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return <div className="min-w-0">{blocks}</div>;
}

/** "label https://url" or just a URL → a link. */
export function HyperLink({ text }: { text: string }) {
  const m = /^(.*?)\s*(\S+)$/.exec(text.trim());
  if (!m) return null;
  const href = safeHref(m[2]);
  if (!href) return <span className="truncate">{text}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-brand-700 underline" onMouseDown={(e) => e.stopPropagation()} title={href}>
      {m[1] || m[2]}
    </a>
  );
}
