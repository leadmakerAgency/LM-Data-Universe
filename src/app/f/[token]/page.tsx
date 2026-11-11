"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FormView } from "@/components/FormView";
import { Logo } from "@/components/Logo";
import { Spinner } from "@/components/ui";
import type { PublicForm } from "@/lib/forms";
import { supabase, errorMessage } from "@/lib/supabase";

/** True when the database doesn't have this function yet (older deployment). */
const missingFunction = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || /could not find the function/i.test(e.message ?? ""));

export default function PublicFormPage() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<PublicForm | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase()
      .rpc("get_public_form", { p_token: token })
      .then(({ data, error }) => {
        if (error) setError(errorMessage(error));
        else setForm((data as PublicForm) ?? null);
      });
  }, [token]);

  useEffect(() => {
    if (form?.title) document.title = form.title;
  }, [form?.title]);

  const upload = async (fieldId: string, file: File): Promise<string> => {
    const sb = supabase();
    const { data, error } = await sb.rpc("form_upload_start", {
      p_token: token,
      p_col: fieldId,
      p_file_name: file.name,
      p_size: file.size,
      p_mime: file.type || "application/octet-stream",
    });
    if (error) throw error;
    const slot = data as { id: string; path: string };
    const up = await sb.storage.from("attachments").upload(slot.path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (up.error) throw new Error(`Could not upload “${file.name}”: ${errorMessage(up.error)}`);
    return slot.id;
  };

  return (
    <main className="min-h-full bg-gradient-to-br from-brand-50 via-white to-sky-50 px-4 py-10">
      <div className="relative mx-auto max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : form === undefined ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : form === null ? (
          <p className="py-6 text-center text-sm text-gray-600">This form is not accepting responses.</p>
        ) : (
          <FormView
            form={form}
            onUpload={upload}
            onSubmit={async (values, meta) => {
              const sb = supabase();
              const { data, error } = await sb.rpc("submit_form", { p_token: token, p_values: values, p_meta: meta });
              if (missingFunction(error)) {
                const old = await sb.rpc("submit_public_form", { p_token: token, p_values: values });
                if (old.error) throw old.error;
                return;
              }
              if (error) throw error;
              const res = data as { ok: boolean; error?: string };
              if (!res.ok) throw new Error(res.error ?? "Your response could not be saved.");
            }}
          />
        )}
      </div>
      <div className="mt-6 flex justify-center opacity-70">
        <Logo />
      </div>
    </main>
  );
}
