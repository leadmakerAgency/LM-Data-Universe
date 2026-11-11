"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useToasts } from "@/store/toasts";

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={clsx(
            "toast-in pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-left text-sm text-white shadow-lg",
            t.kind === "error" ? "bg-red-600" : t.kind === "success" ? "bg-emerald-600" : "bg-gray-800",
          )}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-brand-600 text-white hover:bg-brand-700",
        variant === "secondary" && "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
        variant === "ghost" && "text-gray-700 hover:bg-gray-100",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className,
      )}
    />
  );
}

export function IconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40",
        className,
      )}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        "h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={clsx(
        "h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("mb-1 text-xs font-medium uppercase tracking-wide text-gray-500", className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx("inline-block h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600", className)}
    />
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      title={name}
      style={{ width: size, height: size, background: `hsl(${hue} 55% 88%)`, color: `hsl(${hue} 45% 30%)` }}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
    >
      {initials || "?"}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-gray-900/30 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-full flex-col rounded-xl bg-white shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton onClick={onClose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </div>
        <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A floating panel anchored to an element or a point, closed by outside click or Escape. */
export function Popover({
  anchor,
  onClose,
  children,
  align = "start",
  className,
}: {
  anchor: HTMLElement | { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r =
      anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const box = ref.current.getBoundingClientRect();
    let left = align === "end" ? r.right - box.width : r.left;
    let top = r.bottom + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, r.top - box.height - 4);
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  if (!anchor || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className={clsx("fixed z-[60] min-w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-xl", className)}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-40",
        danger ? "text-red-600 hover:bg-red-50" : "text-gray-700 hover:bg-gray-100",
      )}
    >
      <span className="flex w-4 justify-center text-gray-400">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 border-t border-gray-100" />;
}

// ---- confirm / prompt dialogs as promises

type DialogRequest =
  | { kind: "confirm"; title: string; message: ReactNode; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void }
  | { kind: "prompt"; title: string; label: string; initial: string; confirmLabel: string; resolve: (v: string | null) => void };

const DialogContext = createContext<{
  confirm(o: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  prompt(o: { title: string; label?: string; initial?: string; confirmLabel?: string }): Promise<string | null>;
} | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");

  const confirm = useCallback(
    (o: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) =>
        setReq({ kind: "confirm", title: o.title, message: o.message, confirmLabel: o.confirmLabel ?? "OK", danger: o.danger ?? false, resolve }),
      ),
    [],
  );
  const prompt = useCallback(
    (o: { title: string; label?: string; initial?: string; confirmLabel?: string }) =>
      new Promise<string | null>((resolve) => {
        setValue(o.initial ?? "");
        setReq({ kind: "prompt", title: o.title, label: o.label ?? "", initial: o.initial ?? "", confirmLabel: o.confirmLabel ?? "Save", resolve });
      }),
    [],
  );

  const close = (result: boolean) => {
    if (!req) return;
    if (req.kind === "confirm") req.resolve(result);
    else req.resolve(result ? value : null);
    setReq(null);
  };

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      <Modal
        open={!!req}
        onClose={() => close(false)}
        title={req?.title}
        width={420}
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button
              variant={req?.kind === "confirm" && req.danger ? "danger" : "primary"}
              onClick={() => close(true)}
              disabled={req?.kind === "prompt" && !value.trim()}
            >
              {req?.confirmLabel}
            </Button>
          </>
        }
      >
        {req?.kind === "confirm" && <div className="text-sm text-gray-600">{req.message}</div>}
        {req?.kind === "prompt" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) close(true);
            }}
          >
            {req.label && <Label>{req.label}</Label>}
            <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
          </form>
        )}
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialogs() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs needs a DialogProvider");
  return ctx;
}
