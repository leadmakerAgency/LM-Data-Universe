-- Notes for whoever opens this database: two apps share this Supabase project.
-- Comments only; nothing behaves differently. Nothing outside `public` is touched.

comment on schema public is
'LM Data Universe (relational spreadsheet app). This Supabase project is SHARED with a separate email app, which lives in schema "email_app" (migrations named email_app_*). '
'Rules: (1) LM Data Universe changes only schema public, cron jobs named lmdu-*, Edge Functions doc-worker / deliver / notify, bucket "attachments" and Vault secrets doc_worker_url / doc_worker_secret. '
'(2) Never change schema email_app or anything named email_app_* from this app, and the reverse. '
'(3) Apply migrations one file at a time; never run "supabase db push", "db reset" or "migration repair" here, because each app''s folder lacks the other''s migrations. '
'(4) Edge Function secrets are project-wide: this app''s are prefixed LMDU_. '
'(5) pg_cron, pg_net, pgcrypto and Vault are used by this app: don''t drop or downgrade them. '
'Details: README.md ("Shared Supabase project") in the LM Data Universe repository.';

comment on function public._kick_notify() is 'LM Data Universe: cron job lmdu-notify; wakes the notify Edge Function (invite, share and mention emails).';
comment on function public._kick_jobs() is 'LM Data Universe: cron job lmdu-deliver; wakes the deliver Edge Function (webhooks and automation emails).';
comment on function public._auto_snapshots() is 'LM Data Universe: cron job lmdu-auto-snapshots (hourly document snapshots).';
comment on function public._purge_trash() is 'LM Data Universe: cron job lmdu-purge-trash (documents in the trash for 30 days).';
comment on function public._jobs_cleanup() is 'LM Data Universe: cron job lmdu-jobs-cleanup (old delivery log rows).';
