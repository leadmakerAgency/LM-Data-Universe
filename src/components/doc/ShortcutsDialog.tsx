"use client";

import { Modal } from "@/components/ui";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Keys as written for this computer: "Mod" is Ctrl, or ⌘ on a Mac. */
function keys(spec: string): string[] {
  const mac = isMac();
  return spec.split("+").map((k) => {
    if (k === "Mod") return mac ? "⌘" : "Ctrl";
    if (k === "Alt") return mac ? "⌥" : "Alt";
    if (k === "Shift") return mac ? "⇧" : "Shift";
    return k;
  });
}

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "General",
    items: [
      ["Mod+Z", "Undo"],
      ["Mod+Shift+Z", "Redo (also Ctrl+Y)"],
      ["Mod+F", "Find on this page; Enter / Shift+Enter for next / previous"],
      ["Mod+/", "Show these shortcuts"],
    ],
  },
  {
    title: "Moving around a table",
    items: [
      ["↑ ↓ ← →", "Move one cell"],
      ["Mod+↑ ↓ ← →", "Move to the first or last row or column"],
      ["Tab", "Next cell (Shift+Tab: previous)"],
      ["PageUp / PageDown", "Move one screen up or down"],
      ["Home / End", "First or last column"],
      ["Mod+Home / Mod+End", "First or last cell"],
      ["Shift+arrows", "Extend the selection"],
      ["Mod+A", "Select the whole table"],
    ],
  },
  {
    title: "Editing",
    items: [
      ["Enter", "Edit the cell (F2 too); typing replaces its value"],
      ["Enter", "While editing: save and move down (Tab: save and move right)"],
      ["Escape", "While editing: cancel"],
      ["Delete", "Clear the selected cells (Backspace too)"],
      ["Mod+C / Mod+X / Mod+V", "Copy, cut and paste cells (one value pastes into the whole selection)"],
      ["Mod+D", "Fill down: the top row of the selection into the rows below"],
      ["Mod+;", "Insert today's date"],
      ["Mod+Shift+;", "Insert the current time"],
      ["Space", "Toggle a checkbox, open attachments, or open the record card"],
      ["Shift+Enter", "Insert a record below"],
      ["Mod+Shift+Delete", "Delete the selected records"],
      ["Mod+Alt+M", "Comment on the cell"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Keyboard shortcuts" width={620}>
      <div className="space-y-5">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{g.title}</h3>
            <dl className="divide-y divide-gray-100 text-sm">
              {g.items.map(([k, what], i) => (
                <div key={i} className="flex items-baseline gap-4 py-1.5">
                  <dt className="w-48 shrink-0">
                    {k.split(" / ").map((alt, j) => (
                      <span key={j}>
                        {j > 0 && <span className="mx-1 text-gray-400">/</span>}
                        {keys(alt).map((part, n) => (
                          <kbd key={n} className="mr-0.5 inline-block rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-gray-700">
                            {part}
                          </kbd>
                        ))}
                      </span>
                    ))}
                  </dt>
                  <dd className="text-gray-700">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
