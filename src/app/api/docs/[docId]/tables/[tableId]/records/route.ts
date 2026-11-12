// Records of a table:
//   GET    ?filter={"Col":[values]}&sort=Col,-Other&limit=100
//   POST   {records: [{fields: {...}}]}                 add
//   PATCH  {records: [{id, fields: {...}}]}             update
//   PUT    {records: [{require: {...}, fields: {...}}]} add or update
//          ?onmany=first|all|none &noadd &noupdate
//   DELETE ?ids=1,2,3  (or POST .../records/delete with [1,2,3])
import { ApiError, call, docId, flag, handle, json, options, parseFilter, parseLimit, readJson, recordList, tableName } from "@/lib/apiServer";

type Ctx = { params: Promise<{ docId: string; tableId: string }> };

export const OPTIONS = options;

async function target(ctx: Ctx) {
  const { docId: id, tableId } = await ctx.params;
  return { p_doc: docId(id), p_table: tableName(tableId) };
}

export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    const url = new URL(req.url);
    return json(
      await call(req, "api_records", {
        ...(await target(ctx)),
        p_filter: parseFilter(url),
        p_sort: url.searchParams.get("sort"),
        p_limit: parseLimit(url),
      }),
    );
  });
}

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => json(await call(req, "api_add_records", { ...(await target(ctx)), p_records: recordList(await readJson(req)) })));
}

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => json(await call(req, "api_update_records", { ...(await target(ctx)), p_records: recordList(await readJson(req)) })));
}

export async function PUT(req: Request, ctx: Ctx) {
  return handle(async () => {
    const url = new URL(req.url);
    const onmany = url.searchParams.get("onmany") ?? "first";
    if (!["first", "all", "none"].includes(onmany)) throw new ApiError(400, "onmany must be first, all or none");
    return json(
      await call(req, "api_upsert_records", {
        ...(await target(ctx)),
        p_records: recordList(await readJson(req)),
        p_onmany: onmany,
        p_add: !flag(url, "noadd"),
        p_update: !flag(url, "noupdate"),
      }),
    );
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return handle(async () => {
    const raw = new URL(req.url).searchParams.get("ids") ?? "";
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (!ids.length || ids.some((n) => !Number.isInteger(n))) throw new ApiError(400, "Pass the record ids as ?ids=1,2,3");
    return json(await call(req, "api_delete_records", { ...(await target(ctx)), p_ids: ids }));
  });
}
