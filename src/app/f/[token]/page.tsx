"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FormView, type PublicForm } from "@/components/FormView";
import { Logo } from "@/components/Logo";
import { Spinner } from "@/components/ui";
import { supabase, errorMessage } from "@/lib/supabase";

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

  return (
    <main className="min-h-full bg-gradient-to-br from-brand-50 via-white to-sky-50 px-4 py-10">
      <div className="mx-auto max-w-xl rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
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
            onSubmit={async (values) => {
              const { error } = await supabase().rpc("submit_public_form", { p_token: token, p_values: values });
              if (error) throw error;
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
