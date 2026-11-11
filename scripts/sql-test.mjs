// npm run test:sql — loads every migration into an in-memory Postgres (PGlite)
// with small stand-ins for the Supabase schemas they use (auth, storage,
// vault, cron, net, realtime), then runs the SQL test files in supabase/tests.
// Nothing touches the real project.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migDir = "supabase/migrations";
const args = process.argv.slice(2);
const tests = args.length ? args : readdirSync("supabase/tests").filter((f) => f.endsWith(".sql")).sort().map((f) => join("supabase/tests", f));
const db = new PGlite();

const stubs = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create schema auth; create schema extensions; create schema storage; create schema vault; create schema cron; create schema net; create schema realtime;
grant usage on schema auth, storage, realtime, extensions to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as $$ select decode(substr(md5(random()::text) || md5(random()::text) || md5(random()::text), 1, n * 2), 'hex') $$;
grant execute on function extensions.gen_random_bytes(int) to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, delete on storage.objects to anon, authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant execute on function storage.foldername(text) to anon, authenticated;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;
create function net.http_post(url text, body jsonb default null, headers jsonb default null, timeout_milliseconds int default 0) returns bigint language sql as $$ select 1::bigint $$;
create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb, private boolean);
alter table realtime.messages enable row level security;
grant select on realtime.messages to authenticated, anon;
create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
grant execute on function realtime.topic() to authenticated, anon;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$
  insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private) $$;
create publication supabase_realtime;
`;

function prep(sql) {
  return sql
    .replace(/create extension[^;]*;/gi, "")
    .replace(/drop extension[^;]*;/gi, "");
}

await db.exec(stubs);
for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
  try {
    await db.exec(prep(readFileSync(join(migDir, f), "utf8")));
  } catch (e) {
    console.error(`MIGRATION FAILED: ${f}\n${e.message}`);
    process.exit(1);
  }
}
console.log("migrations ok");
let failed = 0;
for (const t of tests) {
  try {
    const res = await db.exec(readFileSync(t, "utf8"));
    for (const r of res) for (const row of r.rows ?? []) if (row.out !== undefined) console.log(row.out);
    console.log(`PASS ${t}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${t}\n${e.message}${e.where ? "\n" + e.where : ""}`);
  }
}
process.exit(failed ? 1 : 0);
