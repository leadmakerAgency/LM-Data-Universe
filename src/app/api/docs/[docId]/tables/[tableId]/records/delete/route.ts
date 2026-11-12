// POST /api/docs/{docId}/tables/{tableId}/records/delete with [1, 2, 3]
import { ApiError, call, docId, handle, json, options, readJson, tableName } from "@/lib/apiServer";

export const OPTIONS = options;

export async function POST(req: Request, ctx: { params: Promise<{ docId: string; tableId: string }> }) {
  return handle(async () => {
    const { docId: id, tableId } = await ctx.params;
    const body = await readJson(req);
    const ids = Array.isArray(body) ? body : (body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids)) throw new ApiError(400, "Send a list of record ids, e.g. [1, 2, 3]");
    return json(await call(req, "api_delete_records", { p_doc: docId(id), p_table: tableName(tableId), p_ids: ids }));
  });
}
