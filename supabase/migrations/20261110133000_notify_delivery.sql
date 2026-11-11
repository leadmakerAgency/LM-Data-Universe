-- Email delivery: every minute, if emails are waiting, pg_net calls the
-- `notify` Edge Function (same URL base and shared secret as the formula
-- worker). The function claims a batch, sends it through SendGrid and reports
-- each result back. Failed emails are retried up to 5 times.
create or replace function public.notify_claim(p_secret text, p_limit int default 50)
returns setof public.notification_queue language plpgsql security definer set search_path = '' as $$
begin
  perform public._check_worker_secret(p_secret);
  return query
  update public.notification_queue q set attempts = q.attempts + 1
  where q.id in (
    select id from public.notification_queue
    where sent_at is null and attempts < 5
    order by id limit least(greatest(p_limit, 1), 200)
    for update skip locked
  )
  returning q.*;
end $$;

create or replace function public.notify_done(p_secret text, p_id bigint, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._check_worker_secret(p_secret);
  update public.notification_queue
  set sent_at = case when p_error is null then now() end, last_error = left(p_error, 1000)
  where id = p_id;
end $$;

create or replace function public._kick_notify()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.notification_queue where sent_at is null and attempts < 5) then
    return;
  end if;
  select replace(decrypted_secret, '/doc-worker', '/notify') into v_url from vault.decrypted_secrets where name = 'doc_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'doc_worker_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    body := '{}'::jsonb
  );
end $$;

revoke execute on function public.notify_claim(text, int), public.notify_done(text, bigint, text), public._kick_notify()
  from public, anon, authenticated;
grant execute on function public.notify_claim(text, int), public.notify_done(text, bigint, text) to service_role;

select cron.schedule('lmdu-notify', '* * * * *', 'select public._kick_notify()');
