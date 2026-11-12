// Server side of the REST API (/api/docs/...). Route handlers pass the
// caller's API key to the database's api_* functions, which resolve it to its
// owner and apply that person's role and access rules. No service key is used.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config";

let client: SupabaseClient | null = null;
function db(): SupabaseClient {
  client ??= createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 10 * 1024 * 1024;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

export const options = () => new Response(null, { status: 204, headers: CORS });

/** The API key from `Authorization: Bearer …` (or `X-API-Key`). */
function apiKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? req.headers.get("x-api-key") ?? "";
  if (!key) throw new ApiError(401, "Send your API key as: Authorization: Bearer <key>");
  return key;
}

export function docId(id: string): string {
  if (!UUID.test(id)) throw new ApiError(404, "Document not found");
  return id;
}

export async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new ApiError(413, "Request body is larger than 10 MB");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "Request body is larger than 10 MB");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(400, "Request body is not valid JSON");
  }
}

// Database error codes -> HTTP statuses.
const STATUS: Record<string, number> = {
  PT400: 400,
  PT401: 401,
  PT404: 404,
  PT429: 429,
  "42501": 403,
  P0002: 404,
  "22P02": 400,
  "22023": 400,
  P0001: 400,
};

/** Calls an api_* function with the request's key and returns its JSON. */
export async function call(req: Request, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db().rpc(fn, { p_key: apiKey(req), ...args });
  if (error) {
    const status = STATUS[error.code ?? ""] ?? 500;
    throw new ApiError(status, status === 500 ? "Something went wrong. Please try again." : error.message);
  }
  return data;
}

/** Runs a handler, turning errors into JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("api error", e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

/** ?filter={"Col": [values]} */
export function parseFilter(url: URL): unknown {
  const raw = url.searchParams.get("filter");
  if (!raw) return null;
  try {
    const f = JSON.parse(raw);
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error();
    return f;
  } catch {
    throw new ApiError(400, 'filter must be a JSON object such as {"Status": ["Done"]}');
  }
}

export function parseLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "" || raw === "0") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "limit must be a whole number");
  return n;
}

/** Record lists come as {records: [...]} (or a bare list). */
export function recordList(body: unknown): unknown[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? (body as { records?: unknown }).records : undefined;
  if (!Array.isArray(list)) throw new ApiError(400, 'Send {"records": [...]}');
  return list;
}

/** Truthy query flag: ?noadd=1, ?noadd=true, ?noadd */
export function flag(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v !== null && v !== "0" && v.toLowerCase() !== "false";
}

/** A table name from the URL (decoded once, if it still needs it). */
export function tableName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
