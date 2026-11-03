"use client";

import { Copy, ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { FormView, type PublicForm } from "@/components/FormView";
import { Button } from "@/components/ui";
import type { DocWidget } from "@/lib/types";
import { tableColumns, useDoc } from "@/store/docStore";
import { toast } from "@/store/toasts";

/** Builds the same form definition the public page receives. */
export function formDefinition(widget: DocWidget): PublicForm {
  const cols = tableColumns(widget.table_ref);
  const fields = (widget.options.fields ?? [])
    .map((f) => {
      const c = cols.find((x) => x.id === f.col);
      if (!c || c.is_formula || c.type === "Ref" || c.type === "RefList") return null;
      return { id: c.id, label: c.label || c.col_id, type: c.type, options: c.options, required: !!f.required, help: f.help ?? "" };
    })
    .filter((f): f is NonNullable<typeof f> => !!f);
  return {
    title: widget.options.formTitle || widget.title || "Form",
    description: widget.options.formDescription ?? "",
    submitLabel: widget.options.submitLabel || "Submit",
    successMessage: widget.options.successMessage || "Thank you! Your response has been recorded.",
    fields,
  };
}

export function FormWidget({ widget }: { widget: DocWidget }) {
  const version = useDoc((s) => s.version);
  const share = useDoc((s) => s.formShares.get(widget.id));
  const role = useDoc((s) => s.role);
  const canEdit = role === "owner" || role === "editor";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const form = useMemo(() => formDefinition(widget), [widget, version]);
  const url = share && typeof window !== "undefined" ? `${window.location.origin}/f/${share.token}` : "";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs">
        <span className={share?.is_active ? "font-medium text-emerald-700" : "text-gray-500"}>
          {share?.is_active ? "● Published, accepting responses" : "○ Not published"}
        </span>
        <div className="flex-1" />
        {canEdit && (
          <Button size="sm" variant={share?.is_active ? "secondary" : "primary"} onClick={() => useDoc.getState().setFormShare(widget.id, !share?.is_active)}>
            {share?.is_active ? "Unpublish" : "Publish form"}
          </Button>
        )}
        {share?.is_active && (
          <>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success("Form link copied");
                } catch {
                  toast.info(`Copy this link: ${url}`);
                }
              }}
            >
              <Copy size={12} /> Copy link
            </Button>
            <a href={url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="ghost">
                <ExternalLink size={12} /> Open
              </Button>
            </a>
          </>
        )}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto bg-gray-50 p-6">
        <div className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <FormView form={form} preview />
        </div>
      </div>
    </div>
  );
}
