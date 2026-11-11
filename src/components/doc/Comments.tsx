"use client";

import clsx from "clsx";
import { Check, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Avatar, Button, IconButton, Popover } from "@/components/ui";
import { personName, threadsByCell, useComments, type DocComment, type Thread } from "@/store/comments";
import { useDoc } from "@/store/docStore";
import { useUi } from "@/store/uiStore";

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Comment text with @mentions highlighted. */
function Body({ c }: { c: DocComment }) {
  const people = useComments((s) => s.people);
  const names = c.mentions.map((id) => personName(people.get(id))).filter(Boolean);
  if (!names.length) return <span className="whitespace-pre-wrap break-words">{c.body}</span>;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "g");
  return (
    <span className="whitespace-pre-wrap break-words">
      {c.body.split(re).map((part, i) =>
        i % 2 ? (
          <span key={i} className="rounded bg-brand-50 px-0.5 font-medium text-brand-700">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** Text box with @mention suggestions; reports the mentioned people's ids. */
function MentionInput({ placeholder, onSubmit, autoFocus }: { placeholder: string; onSubmit: (body: string, mentions: string[]) => Promise<boolean>; autoFocus?: boolean }) {
  const people = useComments((s) => s.people);
  const me = useDoc((s) => s.me?.UserID);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const m = /@([\p{L}\p{N}._-]*)$/u.exec(text.slice(0, caret));
  const query = m ? m[1].toLowerCase() : null;
  const options =
    query === null
      ? []
      : [...people.values()].filter((p) => p.id !== me && (personName(p).toLowerCase().includes(query) || p.email.toLowerCase().includes(query))).slice(0, 6);

  const pick = (id: string) => {
    const name = personName(people.get(id));
    const before = text.slice(0, caret).replace(/@[\p{L}\p{N}._-]*$/u, `@${name} `);
    setText(before + text.slice(caret));
    setPicked(new Map(picked).set(id, name));
    setHi(0);
    setCaret(before.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const mentions = [...picked].filter(([, name]) => body.includes(`@${name}`)).map(([id]) => id);
    setBusy(true);
    const ok = await onSubmit(body, mentions);
    setBusy(false);
    if (ok) {
      setText("");
      setPicked(new Map());
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        value={text}
        rows={Math.min(5, Math.max(2, text.split("\n").length))}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
          } else if (options.length && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            pick(options[Math.min(hi, options.length - 1)].id);
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        className="w-full resize-none rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
      />
      {options.length > 0 && (
        <ul className="absolute bottom-full left-0 z-10 mb-1 w-64 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          {options.map((p, i) => (
            <li key={p.id}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p.id);
                }}
                className={clsx("flex w-full items-center gap-2 px-2 py-1 text-left text-sm", i === hi ? "bg-brand-50" : "hover:bg-gray-50")}
              >
                <Avatar name={personName(p)} size={20} />
                <span className="truncate">{personName(p)}</span>
                <span className="truncate text-xs text-gray-400">{p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">Type @ to mention someone · Enter to send</span>
        <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={submit}>
          Send
        </Button>
      </div>
    </div>
  );
}

function CommentItem({ c, canResolve, isRoot }: { c: DocComment; canResolve: boolean; isRoot: boolean }) {
  const people = useComments((s) => s.people);
  const me = useDoc((s) => s.me?.UserID);
  const role = useDoc((s) => s.role);
  const author = people.get(c.author);
  const mine = c.author === me;
  return (
    <div className="group flex gap-2">
      <Avatar name={personName(author)} size={24} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-gray-800">{mine ? "You" : personName(author)}</span>
          <span className="text-gray-400">{timeAgo(c.created_at)}</span>
          <span className="flex-1" />
          {isRoot && canResolve && (
            <IconButton title={c.resolved ? "Reopen" : "Resolve"} onClick={() => useComments.getState().setResolved(c.id, !c.resolved)} className="h-6 w-6">
              {c.resolved ? <RotateCcw size={12} /> : <Check size={13} />}
            </IconButton>
          )}
          {(mine || role === "owner") && (
            <IconButton title="Delete" onClick={() => useComments.getState().remove(c.id)} className="h-6 w-6 opacity-0 group-hover:opacity-100">
              <Trash2 size={12} />
            </IconButton>
          )}
        </div>
        <div className="text-sm text-gray-800">
          <Body c={c} />
        </div>
      </div>
    </div>
  );
}

function ThreadView({ t }: { t: Thread }) {
  const me = useDoc((s) => s.me?.UserID);
  const role = useDoc((s) => s.role);
  const canResolve = t.root.author === me || role === "owner" || role === "editor";
  return (
    <div className={clsx("space-y-2 rounded-md p-2", t.root.resolved ? "bg-gray-50 opacity-75" : "bg-white")}>
      {t.root.resolved && <div className="text-[11px] font-medium uppercase tracking-wide text-green-700">Resolved</div>}
      <CommentItem c={t.root} canResolve={canResolve} isRoot />
      {t.replies.map((r) => (
        <div key={r.id} className="pl-6">
          <CommentItem c={r} canResolve={false} isRoot={false} />
        </div>
      ))}
      {!t.root.resolved && (
        <div className="pl-6">
          <MentionInput placeholder="Reply…" onSubmit={(body, mentions) => useComments.getState().add({ tableRef: "", rowId: 0, colId: "", body, mentions, parentId: t.root.id })} />
        </div>
      )}
    </div>
  );
}

/** Popover with the comment threads of one cell, and a box to start a new one. */
export function CellCommentsPopover() {
  const open = useComments((s) => s.openThread);
  const comments = useComments((s) => s.comments);
  const signedIn = !!useDoc((s) => s.me?.UserID);
  const threads = useMemo(() => (open ? (threadsByCell(comments).get(`${open.tableRef}:${open.rowId}:${open.colId}`) ?? []) : []), [open, comments]);
  if (!open) return null;
  const close = () => useComments.getState().open(null);
  const anchor = open.anchor ?? { x: window.innerWidth / 2, y: 120 };
  return (
    <Popover anchor={anchor} onClose={close} className="w-96 p-2">
      <div className="scroll-thin max-h-[60vh] space-y-2 overflow-y-auto">
        {threads.map((t) => (
          <ThreadView key={t.root.id} t={t} />
        ))}
        {signedIn ? (
          <div className={clsx(threads.length && "border-t border-gray-100 pt-2")}>
            <MentionInput
              autoFocus
              placeholder={threads.length ? "Start another thread…" : "Write a comment…"}
              onSubmit={(body, mentions) => useComments.getState().add({ tableRef: open.tableRef, rowId: open.rowId, colId: open.colId, body, mentions })}
            />
          </div>
        ) : (
          <p className="p-2 text-sm text-gray-500">Sign in to comment.</p>
        )}
      </div>
    </Popover>
  );
}

/** Side panel listing every thread, with filters; clicking one jumps to its cell. */
export function CommentsPanel() {
  const comments = useComments((s) => s.comments);
  const people = useComments((s) => s.people);
  const me = useDoc((s) => s.me?.UserID);
  const tables = useDoc((s) => s.tables);
  const columns = useDoc((s) => s.columns);
  const widgets = useDoc((s) => s.widgets);
  const [show, setShow] = useState<"open" | "resolved" | "all">("open");
  const [mine, setMine] = useState(false);
  const threads = [...threadsByCell(comments).values()]
    .flat()
    .filter((t) => (show === "all" ? true : show === "open" ? !t.root.resolved : t.root.resolved))
    .filter((t) => !mine || t.root.author === me || t.root.mentions.includes(me ?? "") || t.replies.some((r) => r.author === me || r.mentions.includes(me ?? "")))
    .sort((a, b) => (b.replies.at(-1)?.created_at ?? b.root.created_at).localeCompare(a.replies.at(-1)?.created_at ?? a.root.created_at));

  const jump = (t: Thread, el: HTMLElement) => {
    const { table_ref, row_id, col_id } = t.root;
    if (!table_ref || row_id == null || !col_id) return;
    // A table widget showing that table, preferably on the current page.
    const page = useUi.getState().activePage;
    const candidates = [...widgets.values()].filter((w) => w.type === "table" && w.table_ref === table_ref);
    const w = candidates.find((x) => x.page_id === page) ?? candidates[0];
    if (w) {
      if (w.page_id !== page) useUi.getState().setActivePage(w.page_id);
      useUi.getState().setActiveWidget(w.id);
      setTimeout(() => useUi.getState().setFindTarget({ widgetId: w.id, rowId: row_id, colId: col_id }), 50);
    }
    const r = el.getBoundingClientRect();
    useComments.getState().open({ tableRef: table_ref, rowId: row_id, colId: col_id, anchor: { x: r.left - 390, y: r.top } });
  };

  return (
    <div className="text-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3 text-xs">
        <div className="flex rounded-md bg-gray-100 p-0.5 font-medium">
          {(["open", "resolved", "all"] as const).map((v) => (
            <button key={v} onClick={() => setShow(v)} className={clsx("rounded px-2 py-1 capitalize", show === v ? "bg-white shadow-sm" : "text-gray-500")}>
              {v}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Involving me
        </label>
      </div>
      {!threads.length && (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-gray-500">
          <MessageSquare size={20} />
          No {show === "all" ? "" : show} comments. Right-click a cell and choose Comment.
        </div>
      )}
      <ul className="divide-y divide-gray-100">
        {threads.map((t) => {
          const table = t.root.table_ref ? tables.get(t.root.table_ref) : undefined;
          const col = t.root.col_id ? columns.get(t.root.col_id) : undefined;
          return (
            <li key={t.root.id}>
              <button className="w-full px-4 py-3 text-left hover:bg-gray-50" onClick={(e) => jump(t, e.currentTarget)}>
                <div className="mb-1 truncate text-[11px] text-gray-400">
                  {table?.table_id ?? "Deleted table"} · {col?.label || col?.col_id || "deleted column"} · row {t.root.row_id}
                </div>
                <div className="line-clamp-2 text-gray-800">
                  <span className="font-medium">{personName(people.get(t.root.author))}:</span> {t.root.body}
                </div>
                <div className="mt-1 text-[11px] text-gray-400">
                  {t.replies.length ? `${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"} · ` : ""}
                  {timeAgo(t.replies.at(-1)?.created_at ?? t.root.created_at)}
                  {t.root.resolved && " · resolved"}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
