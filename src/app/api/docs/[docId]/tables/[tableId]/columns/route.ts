// GET /api/docs/{docId}/tables/{tableId}/columns
import { call, docId, handle, json, options, tableName } from "@/lib/apiServer";

export const OPTIONS = options;

export async function GET(req: Request, ctx: { params: Promise<{ docId: string; tableId: string }> }) {
  return handle(async () => {
    const { docId: id, tableId } = await ctx.params;
    return json(await call(req, "api_columns", { p_doc: docId(id), p_table: tableName(tableId) }));
  });
}
