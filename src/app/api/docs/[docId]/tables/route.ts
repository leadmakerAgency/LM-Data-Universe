// GET /api/docs/{docId}/tables
import { call, docId, handle, json, options } from "@/lib/apiServer";

export const OPTIONS = options;

export async function GET(req: Request, ctx: { params: Promise<{ docId: string }> }) {
  return handle(async () => {
    const { docId: id } = await ctx.params;
    return json(await call(req, "api_tables", { p_doc: docId(id) }));
  });
}
