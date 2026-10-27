-- ZYVEN AI: assistant conversations, usage limits, bug reports, and the
-- developer testing checklist.
--
-- Privacy model
--   * Every AI conversation belongs to exactly one account. Row level
--     security lets only that account read or delete it. Nobody else,
--     including other users and the AI itself, can read it.
--   * The AI never gets access to the messages table. The server function
--     only sends what the user typed in the ZYVEN AI screen (plus app
--     diagnostics when the user turns that on for a message).
--   * Usage limits are counted on the server. Users can't reset them.
--   * Developer Testing Mode is only for accounts listed in dev_testers.
--     That list can only be changed from the Supabase dashboard (SQL), never
--     from the app.

-- ---------- Conversations and messages ----------
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null default 'assistant' check (mode in ('assistant', 'testing')),
  title text not null default '' check (char_length(title) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_user_idx on public.ai_conversations (user_id, updated_at desc);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 16000),
  actions text[] not null default '{}',
  shared_diagnostics boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ai_messages_conv_idx on public.ai_messages (conversation_id, created_at);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

drop policy if exists "ai conversations: owner reads" on public.ai_conversations;
drop policy if exists "ai conversations: owner creates" on public.ai_conversations;
drop policy if exists "ai conversations: owner renames" on public.ai_conversations;
drop policy if exists "ai conversations: owner deletes" on public.ai_conversations;
create policy "ai conversations: owner reads" on public.ai_conversations for select to authenticated using (user_id = (select auth.uid()));
create policy "ai conversations: owner creates" on public.ai_conversations for insert to authenticated with check (user_id = (select auth.uid()));
create policy "ai conversations: owner renames" on public.ai_conversations for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "ai conversations: owner deletes" on public.ai_conversations for delete to authenticated using (user_id = (select auth.uid()));

-- Messages are written by the zyven-ai server function (as the user), read
-- and deleted by their owner. Users can't edit them afterwards.
drop policy if exists "ai messages: owner reads" on public.ai_messages;
drop policy if exists "ai messages: owner writes" on public.ai_messages;
drop policy if exists "ai messages: owner deletes" on public.ai_messages;
create policy "ai messages: owner reads" on public.ai_messages for select to authenticated using (user_id = (select auth.uid()));
create policy "ai messages: owner writes" on public.ai_messages for insert to authenticated with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = (select auth.uid()))
);
create policy "ai messages: owner deletes" on public.ai_messages for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.ai_conversations, public.ai_messages from anon;
revoke update on public.ai_messages from authenticated;
grant select, insert, delete on public.ai_messages to authenticated;
grant select, insert, update, delete on public.ai_conversations to authenticated;

-- ---------- Usage limits ----------
-- One row per AI request. Nobody can insert, change or delete rows directly;
-- only ai_take_quota() (below) adds them.
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_idx on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_time_idx on public.ai_usage (created_at);
alter table public.ai_usage enable row level security;
drop policy if exists "ai usage: owner reads" on public.ai_usage;
create policy "ai usage: owner reads" on public.ai_usage for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;

-- Records one AI request for the signed-in user if they are under the limits.
-- Limits: 12 a minute, 60 an hour, 200 a day per account, and 5000 a day for
-- the whole app (a cost safety net). Returns 'ok' or the limit that was hit.
create or replace function public.ai_take_quota()
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'ZYVEN_NOT_SIGNED_IN' using errcode = '42501'; end if;
  -- One request at a time per account, so parallel calls can't skip the count.
  perform pg_advisory_xact_lock(hashtextextended(me::text, 7));
  if (select count(*) from public.ai_usage where user_id = me and created_at > now() - interval '1 minute') >= 12 then return 'minute'; end if;
  if (select count(*) from public.ai_usage where user_id = me and created_at > now() - interval '1 hour') >= 60 then return 'hour'; end if;
  if (select count(*) from public.ai_usage where user_id = me and created_at > now() - interval '1 day') >= 200 then return 'day'; end if;
  if (select count(*) from public.ai_usage where created_at > now() - interval '1 day') >= 5000 then return 'global'; end if;
  insert into public.ai_usage (user_id) values (me);
  delete from public.ai_usage where created_at < now() - interval '3 days';
  return 'ok';
end;
$$;
revoke all on function public.ai_take_quota() from public, anon;
grant execute on function public.ai_take_quota() to authenticated;

-- ---------- Developer Testing Mode ----------
-- Add a tester from the Supabase SQL editor, e.g.:
--   insert into public.dev_testers (user_id)
--   select id from auth.users where email = 'you@example.com';
create table if not exists public.dev_testers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.dev_testers enable row level security;
drop policy if exists "dev testers: see yourself" on public.dev_testers;
create policy "dev testers: see yourself" on public.dev_testers for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.dev_testers from anon, authenticated;
grant select on public.dev_testers to authenticated;

create or replace function public.is_dev_tester()
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.dev_testers where user_id = auth.uid());
$$;
revoke all on function public.is_dev_tester() from public, anon;
grant execute on function public.is_dev_tester() to authenticated;

create table if not exists public.test_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_key text not null check (item_key ~ '^[a-z0-9_.-]{1,60}$'),
  status text not null check (status in ('pass', 'fail', 'untested')),
  note text not null default '' check (char_length(note) <= 1000),
  app_version text not null default '' check (char_length(app_version) <= 40),
  platform text not null default '' check (char_length(platform) <= 40),
  updated_at timestamptz not null default now(),
  unique (user_id, item_key)
);
alter table public.test_results enable row level security;
drop policy if exists "test results: testers read own" on public.test_results;
drop policy if exists "test results: testers write own" on public.test_results;
drop policy if exists "test results: testers update own" on public.test_results;
drop policy if exists "test results: testers delete own" on public.test_results;
create policy "test results: testers read own" on public.test_results for select to authenticated using (user_id = (select auth.uid()) and (select public.is_dev_tester()));
create policy "test results: testers write own" on public.test_results for insert to authenticated with check (user_id = (select auth.uid()) and (select public.is_dev_tester()));
create policy "test results: testers update own" on public.test_results for update to authenticated using (user_id = (select auth.uid()) and (select public.is_dev_tester())) with check (user_id = (select auth.uid()) and (select public.is_dev_tester()));
create policy "test results: testers delete own" on public.test_results for delete to authenticated using (user_id = (select auth.uid()) and (select public.is_dev_tester()));
revoke all on public.test_results from anon;
grant select, insert, update, delete on public.test_results to authenticated;

-- ---------- Bug reports ----------
-- Any signed-in user can file a report and read their own. Diagnostics are
-- only attached when the user ticks the box, and never contain message text,
-- passwords, or tokens (the app builds them from a fixed list of fields).
create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  steps text not null default '' check (char_length(steps) <= 3000),
  expected text not null default '' check (char_length(expected) <= 1500),
  actual text not null default '' check (char_length(actual) <= 1500),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  certainty text not null default 'possible' check (certainty in ('confirmed', 'possible')),
  diagnostics jsonb check (diagnostics is null or pg_column_size(diagnostics) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists bug_reports_user_idx on public.bug_reports (user_id, created_at desc);
alter table public.bug_reports enable row level security;
drop policy if exists "bug reports: owner reads" on public.bug_reports;
drop policy if exists "bug reports: owner files" on public.bug_reports;
drop policy if exists "bug reports: owner deletes" on public.bug_reports;
create policy "bug reports: owner reads" on public.bug_reports for select to authenticated using (user_id = (select auth.uid()));
create policy "bug reports: owner files" on public.bug_reports for insert to authenticated with check (user_id = (select auth.uid()));
create policy "bug reports: owner deletes" on public.bug_reports for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.bug_reports from anon;
revoke update on public.bug_reports from authenticated;
grant select, insert, delete on public.bug_reports to authenticated;

-- Keep updated_at fresh on conversations.
drop trigger if exists ai_conversations_touch on public.ai_conversations;
create trigger ai_conversations_touch before update on public.ai_conversations
  for each row execute function public.touch_updated_at();
