// POST /api/import-url {url} with the signed-in person's access token:
// downloads a public CSV / Excel file for the import dialog (browsers can't
// fetch most of these themselves). Local and private addresses are refused.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/config";
import { UrlImportError, fetchPublicFile } from "@/lib/urlImport";

const error = (status: number, message: string) => Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return error(401, "Sign in to import from a web address");
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: user, error: authError } = await sb.auth.getUser(token);
  if (authError || !user?.user) return error(401, "Sign in to import from a web address");

  let url = "";
  try {
    url = String(((await req.json()) as { url?: unknown })?.url ?? "");
  } catch {
    return error(400, "Send {\"url\": \"https://…\"}");
  }
  if (!url || url.length > 2000) return error(400, "Send {\"url\": \"https://…\"}");
  try {
    const file = await fetchPublicFile(url);
    return new Response(file.bytes, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof UrlImportError) return error(e.status, e.message);
    return error(500, "Couldn't download that address");
  }
}
