-- =====================================================================
-- ZYVEN backend: accounts, profiles, contacts, conversations, messages,
-- media storage, realtime. Runs on Supabase (Postgres + Auth + Storage +
-- Realtime). Paste the whole file into the Supabase SQL Editor once.
--
-- Security model
--   * Every table has Row Level Security. The app only uses the public
--     "anon" key; what a signed-in person can read or change is decided
--     here, not in the app.
--   * People can read and write only conversations they belong to.
--   * Changes with rules (editing, deleting, reactions, group admin
--     actions, read receipts) go through the functions below, which
--     check permissions before writing.
--   * Profiles are read through get_profiles() / search_profiles(), which
--     apply each person's privacy choices (photo, online, last seen).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profiles: one per account, created automatically at sign-up.
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._]{3,24}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 32),
  bio text not null default '' check (char_length(bio) <= 140),
  hue integer not null default 250 check (hue between 0 and 360),
  avatar_path text check (avatar_path is null or char_length(avatar_path) <= 200),
  privacy_online text not null default 'everyone' check (privacy_online in ('everyone', 'contacts', 'nobody')),
  privacy_last_seen text not null default 'everyone' check (privacy_last_seen in ('everyone', 'contacts', 'nobody')),
  privacy_photo text not null default 'everyone' check (privacy_photo in ('everyone', 'contacts', 'nobody')),
  read_receipts boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Contacts and blocks: private lists, each owned by one person.
-- ---------------------------------------------------------------------
create table public.contacts (
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, contact_id),
  constraint contacts_not_self check (owner_id <> contact_id)
);
create index contacts_contact_idx on public.contacts (contact_id);

create table public.blocks (
  blocker_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  reported_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 60),
  details text not null default '' check (char_length(details) <= 300),
  created_at timestamptz not null default now(),
  constraint reports_not_self check (reporter_id <> reported_id)
);

-- ---------------------------------------------------------------------
-- Conversations: direct (two people) or group.
-- direct_key = "<smaller uuid>:<larger uuid>" makes duplicate direct
-- conversations between the same two people impossible.
-- ---------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group')),
  direct_key text unique,
  title text check (title is null or char_length(btrim(title)) between 1 and 40),
  description text not null default '' check (char_length(description) <= 120),
  pic jsonb check (pic is null or pg_column_size(pic) <= 2048),
  edit_info text not null default 'all' check (edit_info in ('all', 'admins')),
  ttl text check (ttl in ('1m', '24h', '7d', '30d')),
  pins uuid[] not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint conversations_direct_key check ((kind = 'direct') = (direct_key is not null)),
  constraint conversations_group_title check (kind = 'direct' or title is not null)
);

-- Membership. left_at is set when someone leaves or is removed; they keep
-- the history from before that moment, like most messengers.
-- delivered_at / read_at are the receipts other members see.
create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

-- Each person's private view of a conversation (unread position, cleared
-- history, hidden). Nobody else can read it.
create table public.member_state (
  conversation_id uuid not null,
  user_id uuid not null,
  last_read_at timestamptz not null default now(),
  cleared_at timestamptz,
  hidden boolean not null default false,
  primary key (conversation_id, user_id),
  foreign key (conversation_id, user_id) references public.conversation_members (conversation_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Messages. Media files live in Storage (bucket chat-media, folder named
-- after the conversation); meta holds their paths and details.
-- ---------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid default auth.uid() references public.profiles (id) on delete set null,
  kind text not null check (kind in ('text', 'image', 'video', 'voice', 'file', 'sticker', 'location', 'system')),
  body text check (body is null or char_length(body) <= 4000),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 16384),
  reactions jsonb not null default '{}' check (jsonb_typeof(reactions) = 'object'),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by text check (deleted_by in ('sender', 'admin')),
  expires_at timestamptz,
  constraint messages_text_has_body check (kind <> 'text' or deleted_at is not null or char_length(btrim(coalesce(body, ''))) > 0)
);
create index messages_conversation_time_idx on public.messages (conversation_id, created_at desc);
create index messages_sender_idx on public.messages (sender_id);

-- =====================================================================
-- Helper functions (SECURITY DEFINER so policies can use them without
-- recursion). Each checks auth.uid(), so they only answer for the caller.
-- =====================================================================
create or replace function public.is_member(conv uuid, active_only boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = auth.uid()
      and (not active_only or m.left_at is null)
  );
$$;

create or replace function public.is_admin(conv uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = auth.uid() and m.left_at is null and m.role = 'admin'
  );
$$;

-- Can the caller see this message (membership window, not expired)?
create or replace function public.can_see_message(conv uuid, created timestamptz, expires timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select (expires is null or expires > now()) and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = auth.uid()
      and created >= m.joined_at - interval '2 seconds'
      and (m.left_at is null or created <= m.left_at)
  );
$$;

-- In a direct conversation, has either person blocked the other?
create or replace function public.is_blocked_in(conv uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.conversations c
    join public.conversation_members other on other.conversation_id = c.id and other.user_id <> auth.uid()
    join public.blocks b on (b.blocker_id = auth.uid() and b.blocked_id = other.user_id)
                         or (b.blocker_id = other.user_id and b.blocked_id = auth.uid())
    where c.id = conv and c.kind = 'direct'
  );
$$;

-- Privacy audience check: may the caller see something `owner` shared
-- with this audience?
create or replace function public.audience_ok(setting text, owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select owner = auth.uid()
      or setting = 'everyone'
      or (setting = 'contacts' and exists (
            select 1 from public.contacts c where c.owner_id = owner and c.contact_id = auth.uid()));
$$;

-- Storage paths look like "<conversation id>/<message id>/<file name>".
create or replace function public.can_use_media(object_name text, write boolean)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  folder text := split_part(object_name, '/', 1);
begin
  if folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_member(folder::uuid, write);
end;
$$;

-- =====================================================================
-- Triggers
-- =====================================================================

-- New account → profile. The app sends username and display name as
-- sign-up metadata; a taken username stops the sign-up with a clear error.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  uname text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  dname text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  h integer := case when coalesce(new.raw_user_meta_data ->> 'hue', '') ~ '^[0-9]{1,3}$'
                    then (new.raw_user_meta_data ->> 'hue')::integer else 250 end;
begin
  if uname !~ '^[a-z0-9._]{3,24}$' then
    raise exception 'ZYVEN_USERNAME_INVALID' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where username = uname) then
    raise exception 'ZYVEN_USERNAME_TAKEN' using errcode = '23505';
  end if;
  if dname = '' then dname := uname; end if;
  insert into public.profiles (id, username, display_name, hue)
  values (new.id, uname, left(dname, 32), least(greatest(h, 0), 360));
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Server decides time, expiry, and starting state of every new message.
create or replace function public.prepare_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  conv_ttl text;
begin
  new.created_at := clock_timestamp();
  new.edited_at := null;
  new.deleted_at := null;
  new.deleted_by := null;
  new.reactions := '{}';
  select c.ttl into conv_ttl from public.conversations c where c.id = new.conversation_id;
  new.expires_at := case conv_ttl
    when '1m' then new.created_at + interval '1 minute'
    when '24h' then new.created_at + interval '24 hours'
    when '7d' then new.created_at + interval '7 days'
    when '30d' then new.created_at + interval '30 days'
    else null end;
  return new;
end;
$$;
create trigger messages_prepare before insert on public.messages
  for each row execute function public.prepare_message();

-- After a message: bump the conversation and bring it back for anyone who
-- had hidden (deleted) the chat on their side.
create or replace function public.after_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  update public.member_state set hidden = false
    where conversation_id = new.conversation_id and hidden;
  return null;
end;
$$;
create trigger messages_after_insert after insert on public.messages
  for each row execute function public.after_message();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.member_state enable row level security;
alter table public.messages enable row level security;

-- Profiles: you read and edit only your own row directly. Everyone else's
-- profile comes through get_profiles()/search_profiles().
create policy "profiles: read own" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles: update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "contacts: read own" on public.contacts for select to authenticated using (owner_id = auth.uid());
create policy "contacts: add own" on public.contacts for insert to authenticated with check (owner_id = auth.uid());
create policy "contacts: remove own" on public.contacts for delete to authenticated using (owner_id = auth.uid());

create policy "blocks: read own" on public.blocks for select to authenticated using (blocker_id = auth.uid());
create policy "blocks: add own" on public.blocks for insert to authenticated with check (blocker_id = auth.uid());
create policy "blocks: remove own" on public.blocks for delete to authenticated using (blocker_id = auth.uid());

create policy "reports: read own" on public.reports for select to authenticated using (reporter_id = auth.uid());
create policy "reports: file own" on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy "reports: delete own" on public.reports for delete to authenticated using (reporter_id = auth.uid());

create policy "conversations: members read" on public.conversations for select to authenticated using (public.is_member(id));
create policy "members: co-members read" on public.conversation_members for select to authenticated using (public.is_member(conversation_id));
create policy "member_state: read own" on public.member_state for select to authenticated using (user_id = auth.uid());

create policy "messages: members read" on public.messages for select to authenticated
  using (public.can_see_message(conversation_id, created_at, expires_at));
create policy "messages: members send" on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and kind <> 'system'
    and public.is_member(conversation_id, true)
    and not public.is_blocked_in(conversation_id)
  );

-- Table privileges: nothing for signed-out visitors; signed-in people get
-- only what the app needs (all other changes go through functions).
revoke all on public.profiles, public.contacts, public.blocks, public.reports, public.conversations,
  public.conversation_members, public.member_state, public.messages from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (username, display_name, bio, hue, avatar_path, privacy_online, privacy_last_seen, privacy_photo, read_receipts)
  on public.profiles to authenticated;
grant select, insert, delete on public.contacts, public.blocks to authenticated;
grant select, insert, delete on public.reports to authenticated;
grant select on public.conversations, public.conversation_members, public.member_state to authenticated;
grant select on public.messages to authenticated;
grant insert (id, conversation_id, kind, body, meta) on public.messages to authenticated;

-- =====================================================================
-- Functions the app calls (RPC). All check the caller first.
-- =====================================================================

-- Profile rows with privacy applied.
create or replace function public.profile_view(ids uuid[])
returns table (
  id uuid, username text, display_name text, bio text, hue integer,
  avatar_path text, online boolean, last_seen_at timestamptz, read_receipts boolean
)
language sql stable security definer set search_path = '' as $$
  with me as (select p.privacy_last_seen as my_last_seen from public.profiles p where p.id = auth.uid())
  select p.id, p.username, p.display_name, p.bio, p.hue,
    case when public.audience_ok(p.privacy_photo, p.id) then p.avatar_path end,
    (p.last_seen_at > now() - interval '2 minutes' and public.audience_ok(p.privacy_online, p.id)),
    case when p.id = auth.uid()
           or (public.audience_ok(p.privacy_last_seen, p.id) and coalesce((select my_last_seen from me), 'everyone') <> 'nobody')
         then p.last_seen_at end,
    p.read_receipts
  from public.profiles p
  where auth.uid() is not null and p.id = any (ids);
$$;

create or replace function public.get_profiles(ids uuid[])
returns table (
  id uuid, username text, display_name text, bio text, hue integer,
  avatar_path text, online boolean, last_seen_at timestamptz, read_receipts boolean
)
language sql stable security definer set search_path = '' as $$
  select * from public.profile_view(ids[1:500]);
$$;

-- Find registered people by @username or display name. Never returns you.
create or replace function public.search_profiles(q text)
returns table (
  id uuid, username text, display_name text, bio text, hue integer,
  avatar_path text, online boolean, last_seen_at timestamptz, read_receipts boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  term text := lower(btrim(regexp_replace(coalesce(q, ''), '^\s*@', '')));
  pat text;
  ids uuid[];
begin
  if auth.uid() is null or char_length(term) < 1 or char_length(term) > 40 then
    return;
  end if;
  pat := '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select array_agg(x.id) into ids from (
    select p.id from public.profiles p
    where p.id <> auth.uid()
      and (p.username like pat escape '\' or lower(p.display_name) like pat escape '\')
    order by (p.username = term) desc, (p.username like term || '%') desc, p.display_name
    limit 20
  ) x;
  if ids is null then return; end if;
  return query
    select v.* from public.profile_view(ids) v
    order by (v.username = term) desc, (v.username like term || '%') desc, v.display_name;
end;
$$;

-- Used at sign-up, before an account exists (so also allowed for anon).
create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select lower(btrim(coalesce(name, ''))) ~ '^[a-z0-9._]{3,24}$'
     and not exists (select 1 from public.profiles p where p.username = lower(btrim(name)));
$$;

-- Presence heartbeat while the app is open.
create or replace function public.touch_presence(visible boolean default true)
returns void language sql volatile security definer set search_path = '' as $$
  update public.profiles set last_seen_at = case when visible then now() else null end where id = auth.uid();
$$;

-- System message helper (group events). Not callable by the app.
create or replace function public.sys_message(conv uuid, action text, targets uuid[], body text, extra jsonb default '{}')
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.messages (conversation_id, sender_id, kind, body, meta)
  values (conv, auth.uid(), 'system', left(body, 400),
          jsonb_build_object('sys', action, 'targets', coalesce(to_jsonb(targets), '[]'::jsonb)) || coalesce(extra, '{}'));
$$;

create or replace function public.name_of(uid uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select display_name from public.profiles where id = uid), 'Someone');
$$;

-- Open (or create once) the direct conversation with another person.
create or replace function public.get_or_create_direct(other uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  k text;
  conv uuid;
begin
  if me is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if other is null or other = me then raise exception 'ZYVEN_CANNOT_CHAT_WITH_SELF' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = other) then
    raise exception 'ZYVEN_USER_NOT_FOUND' using errcode = 'P0002';
  end if;
  k := least(me::text, other::text) || ':' || greatest(me::text, other::text);
  insert into public.conversations (kind, direct_key, created_by) values ('direct', k, me)
    on conflict (direct_key) do nothing;
  select id into conv from public.conversations where direct_key = k;
  insert into public.conversation_members (conversation_id, user_id) values (conv, me), (conv, other)
    on conflict do nothing;
  insert into public.member_state (conversation_id, user_id) values (conv, me), (conv, other)
    on conflict do nothing;
  update public.member_state set hidden = false where conversation_id = conv and user_id = me;
  return conv;
end;
$$;

create or replace function public.create_group(group_title text, group_description text, group_pic jsonb, member_ids uuid[])
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  conv uuid;
  ids uuid[];
begin
  if me is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(group_title, ''))) = 0 then raise exception 'ZYVEN_GROUP_NAME_REQUIRED' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct p.id), '{}') into ids
    from public.profiles p where p.id = any (coalesce(member_ids, '{}')) and p.id <> me;
  if cardinality(ids) = 0 then raise exception 'ZYVEN_GROUP_NEEDS_MEMBERS' using errcode = '22023'; end if;
  if cardinality(ids) > 255 then raise exception 'ZYVEN_GROUP_TOO_LARGE' using errcode = '22023'; end if;
  insert into public.conversations (kind, title, description, pic, created_by)
    values ('group', left(btrim(group_title), 40), left(btrim(coalesce(group_description, '')), 120), group_pic, me)
    returning id into conv;
  insert into public.conversation_members (conversation_id, user_id, role) values (conv, me, 'admin');
  insert into public.conversation_members (conversation_id, user_id) select conv, unnest(ids);
  insert into public.member_state (conversation_id, user_id) select conv, unnest(ids || me);
  perform public.sys_message(conv, 'created', '{}', public.name_of(me) || ' created "' || left(btrim(group_title), 40) || '"');
  perform public.sys_message(conv, 'added', ids, public.name_of(me) || ' added '
    || (select string_agg(public.name_of(x), ', ') from unnest(ids) x));
  return conv;
end;
$$;

create or replace function public.add_members(conv uuid, member_ids uuid[])
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  ids uuid[];
begin
  if not public.is_admin(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  if (select kind from public.conversations where id = conv) <> 'group' then raise exception 'Not a group' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct p.id), '{}') into ids
    from public.profiles p
    where p.id = any (coalesce(member_ids, '{}'))
      and not exists (select 1 from public.conversation_members m where m.conversation_id = conv and m.user_id = p.id and m.left_at is null);
  if cardinality(ids) = 0 then return; end if;
  insert into public.conversation_members (conversation_id, user_id) select conv, unnest(ids)
    on conflict (conversation_id, user_id) do update set left_at = null, role = 'member', joined_at = now(),
      delivered_at = null, read_at = null;
  insert into public.member_state (conversation_id, user_id) select conv, unnest(ids)
    on conflict (conversation_id, user_id) do update set last_read_at = now(), cleared_at = null, hidden = false;
  perform public.sys_message(conv, 'added', ids, public.name_of(auth.uid()) || ' added '
    || (select string_agg(public.name_of(x), ', ') from unnest(ids) x));
end;
$$;

create or replace function public.remove_member(conv uuid, member uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  if member = auth.uid() then raise exception 'Use leave_group to leave' using errcode = '22023'; end if;
  update public.conversation_members set left_at = now(), role = 'member'
    where conversation_id = conv and user_id = member and left_at is null;
  if not found then return; end if;
  perform public.sys_message(conv, 'removed', array[member], public.name_of(auth.uid()) || ' removed ' || public.name_of(member));
end;
$$;

create or replace function public.leave_group(conv uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  heir uuid;
begin
  if not public.is_member(conv, true) then return; end if;
  if (select kind from public.conversations where id = conv) <> 'group' then raise exception 'Not a group' using errcode = '22023'; end if;
  if public.is_admin(conv) and not exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id <> me and left_at is null and role = 'admin'
  ) then
    select user_id into heir from public.conversation_members
      where conversation_id = conv and user_id <> me and left_at is null order by joined_at limit 1;
    if heir is not null then
      update public.conversation_members set role = 'admin' where conversation_id = conv and user_id = heir;
    end if;
  end if;
  perform public.sys_message(conv, 'left', '{}', public.name_of(me) || ' left');
  update public.conversation_members set left_at = clock_timestamp(), role = 'member' where conversation_id = conv and user_id = me;
  if heir is not null then
    insert into public.messages (conversation_id, sender_id, kind, body, meta)
      values (conv, heir, 'system', public.name_of(heir) || ' is now an admin',
              jsonb_build_object('sys', 'admin', 'targets', jsonb_build_array(heir), 'auto', true));
  end if;
end;
$$;

create or replace function public.set_admin(conv uuid, member uuid, make_admin boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  update public.conversation_members set role = case when make_admin then 'admin' else 'member' end
    where conversation_id = conv and user_id = member and left_at is null
      and role <> case when make_admin then 'admin' else 'member' end;
  if not found then return; end if;
  perform public.sys_message(conv, case when make_admin then 'admin' else 'unadmin' end, array[member],
    public.name_of(member) || case when make_admin then ' is now an admin' else ' is no longer an admin' end);
end;
$$;

create or replace function public.can_edit_info(conv uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_member(conv, true) and (
    public.is_admin(conv)
    or (select c.kind = 'direct' or c.edit_info = 'all' from public.conversations c where c.id = conv)
  );
$$;

create or replace function public.update_group(conv uuid, group_title text, group_description text, group_pic jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.conversations;
  t text := left(btrim(coalesce(group_title, '')), 40);
  d text := left(btrim(coalesce(group_description, '')), 120);
begin
  select * into c from public.conversations where id = conv;
  if c.id is null or c.kind <> 'group' then raise exception 'Not a group' using errcode = '22023'; end if;
  if not public.can_edit_info(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  if t = '' then raise exception 'ZYVEN_GROUP_NAME_REQUIRED' using errcode = '22023'; end if;
  update public.conversations set title = t, description = d, pic = coalesce(group_pic, pic) where id = conv;
  if t <> c.title then
    perform public.sys_message(conv, 'renamed', '{}', public.name_of(auth.uid()) || ' renamed the group to "' || t || '"', jsonb_build_object('value', t));
  end if;
  if d <> c.description then
    perform public.sys_message(conv, 'desc', '{}', public.name_of(auth.uid()) || ' updated the group description');
  end if;
  if group_pic is not null and group_pic is distinct from c.pic then
    perform public.sys_message(conv, 'pic', '{}', public.name_of(auth.uid()) || ' changed the group picture');
  end if;
end;
$$;

create or replace function public.set_edit_info(conv uuid, who text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  if who not in ('all', 'admins') then raise exception 'Invalid value' using errcode = '22023'; end if;
  update public.conversations set edit_info = who where id = conv and kind = 'group' and edit_info <> who;
  if found then
    perform public.sys_message(conv, 'editinfo', '{}', public.name_of(auth.uid()) || case when who = 'admins'
      then ' allowed only admins to edit group info' else ' allowed all members to edit group info' end, jsonb_build_object('value', who));
  end if;
end;
$$;

create or replace function public.set_ttl(conv uuid, value text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.can_edit_info(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  if value is not null and value not in ('1m', '24h', '7d', '30d') then raise exception 'Invalid value' using errcode = '22023'; end if;
  update public.conversations set ttl = value where id = conv and ttl is distinct from value;
  if found then
    perform public.sys_message(conv, 'ttl', '{}', public.name_of(auth.uid()) || case when value is null
      then ' turned off disappearing messages' else ' turned on disappearing messages' end, jsonb_build_object('value', value));
  end if;
end;
$$;

create or replace function public.toggle_pin(conv uuid, msg uuid)
returns uuid[] language plpgsql volatile security definer set search_path = '' as $$
declare
  cur uuid[];
begin
  if not public.can_edit_info(conv) then raise exception 'ZYVEN_ADMINS_ONLY' using errcode = '42501'; end if;
  if not exists (select 1 from public.messages where id = msg and conversation_id = conv and deleted_at is null and kind <> 'system') then
    raise exception 'ZYVEN_MESSAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  select pins into cur from public.conversations where id = conv for update;
  if msg = any (cur) then
    cur := array_remove(cur, msg);
  else
    cur := cur || msg;
    if cardinality(cur) > 5 then cur := cur[cardinality(cur) - 4:]; end if;
    perform public.sys_message(conv, 'pinned', '{}', public.name_of(auth.uid()) || ' pinned a message', jsonb_build_object('msg', msg));
  end if;
  update public.conversations set pins = cur where id = conv;
  return cur;
end;
$$;

create or replace function public.edit_message(msg uuid, new_body text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.messages;
begin
  select * into m from public.messages where id = msg;
  if m.id is null or m.sender_id is distinct from auth.uid() or m.kind <> 'text' or m.deleted_at is not null then
    raise exception 'ZYVEN_CANNOT_EDIT' using errcode = '42501';
  end if;
  if not public.is_member(m.conversation_id, true) then raise exception 'ZYVEN_CANNOT_EDIT' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(new_body, ''))) = 0 then raise exception 'ZYVEN_EMPTY_MESSAGE' using errcode = '22023'; end if;
  update public.messages set body = left(new_body, 4000), edited_at = now() where id = msg and body is distinct from new_body;
end;
$$;

-- Delete for everyone: the sender, or a group admin. Returns the storage
-- paths the app should remove.
create or replace function public.delete_message(msg uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.messages;
  by_admin boolean;
begin
  select * into m from public.messages where id = msg;
  if m.id is null or m.deleted_at is not null then return '{}'; end if;
  by_admin := m.sender_id is distinct from auth.uid();
  if m.kind = 'system' or (by_admin and not public.is_admin(m.conversation_id))
     or (not by_admin and not public.is_member(m.conversation_id)) then
    raise exception 'ZYVEN_CANNOT_DELETE' using errcode = '42501';
  end if;
  update public.messages
    set deleted_at = now(), deleted_by = case when by_admin then 'admin' else 'sender' end,
        body = null, meta = '{}', reactions = '{}'
    where id = msg;
  update public.conversations set pins = array_remove(pins, msg) where id = m.conversation_id and msg = any (pins);
  return m.meta;
end;
$$;

-- One reaction per person per message; the same emoji again removes it.
create or replace function public.toggle_reaction(msg uuid, emoji text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.messages;
  me text := auth.uid()::text;
  had boolean;
  r jsonb := '{}';
  k text;
  v jsonb;
begin
  if emoji is null or char_length(emoji) = 0 or char_length(emoji) > 16 then raise exception 'Invalid emoji' using errcode = '22023'; end if;
  select * into m from public.messages where id = msg for update;
  if m.id is null or m.deleted_at is not null or m.kind = 'system'
     or not public.is_member(m.conversation_id, true)
     or not public.can_see_message(m.conversation_id, m.created_at, m.expires_at) then
    raise exception 'ZYVEN_CANNOT_REACT' using errcode = '42501';
  end if;
  had := coalesce(m.reactions -> emoji, '[]'::jsonb) ? me;
  for k, v in select * from jsonb_each(m.reactions) loop
    v := coalesce((select jsonb_agg(x) from jsonb_array_elements(v) x where x <> to_jsonb(me)), '[]'::jsonb);
    if jsonb_array_length(v) > 0 then r := r || jsonb_build_object(k, v); end if;
  end loop;
  if not had then
    r := r || jsonb_build_object(emoji, coalesce(r -> emoji, '[]'::jsonb) || to_jsonb(me));
  end if;
  update public.messages set reactions = r where id = msg;
  return r;
end;
$$;

-- Receipts and private read position.
create or replace function public.mark_read(conv uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  share boolean := coalesce((select read_receipts from public.profiles where id = auth.uid()), true);
begin
  update public.member_state set last_read_at = now() where conversation_id = conv and user_id = auth.uid();
  update public.conversation_members
    set delivered_at = now(), read_at = case when share then now() else read_at end
    where conversation_id = conv and user_id = auth.uid() and left_at is null;
end;
$$;

create or replace function public.mark_delivered(convs uuid[])
returns void language sql volatile security definer set search_path = '' as $$
  update public.conversation_members set delivered_at = now()
    where user_id = auth.uid() and conversation_id = any (convs) and left_at is null;
$$;

create or replace function public.mark_unread(conv uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update public.member_state set last_read_at = coalesce(
      (select m.created_at - interval '1 millisecond' from public.messages m
        where m.conversation_id = conv and m.sender_id is distinct from auth.uid() and m.kind <> 'system'
        order by m.created_at desc limit 1), last_read_at)
    where conversation_id = conv and user_id = auth.uid();
$$;

-- "Clear history" and "delete chat" only change your own view.
create or replace function public.clear_chat(conv uuid, hide boolean default false)
returns void language sql volatile security definer set search_path = '' as $$
  update public.member_state set cleared_at = now(), last_read_at = now(), hidden = hide
    where conversation_id = conv and user_id = auth.uid();
$$;

-- Everything the chat list needs, in one call (respects RLS: invoker).
create or replace function public.my_unread_counts()
returns table (conversation_id uuid, unread bigint)
language sql stable set search_path = '' as $$
  select s.conversation_id, count(m.id)
  from public.member_state s
  join public.messages m on m.conversation_id = s.conversation_id
  where s.user_id = auth.uid()
    and m.created_at > greatest(s.last_read_at, coalesce(s.cleared_at, '-infinity'))
    and m.sender_id is distinct from auth.uid() and m.kind <> 'system' and m.deleted_at is null
  group by s.conversation_id;
$$;

-- Latest messages of every conversation (invoker: RLS decides visibility).
create or replace function public.recent_messages(per_conversation integer default 40)
returns setof public.messages
language sql stable set search_path = '' as $$
  select m.* from public.member_state s
  cross join lateral (
    select * from public.messages x
    where x.conversation_id = s.conversation_id
      and x.created_at > coalesce(s.cleared_at, '-infinity')
    order by x.created_at desc
    limit least(greatest(per_conversation, 1), 200)
  ) m
  where s.user_id = auth.uid();
$$;

-- Function privileges: only signed-in people; username_available also
-- before sign-up. Internal helpers are not callable from the app.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.get_profiles(uuid[]), public.search_profiles(text), public.touch_presence(boolean),
  public.get_or_create_direct(uuid), public.create_group(text, text, jsonb, uuid[]),
  public.add_members(uuid, uuid[]), public.remove_member(uuid, uuid), public.leave_group(uuid),
  public.set_admin(uuid, uuid, boolean), public.update_group(uuid, text, text, jsonb),
  public.set_edit_info(uuid, text), public.set_ttl(uuid, text), public.toggle_pin(uuid, uuid),
  public.edit_message(uuid, text), public.delete_message(uuid), public.toggle_reaction(uuid, text),
  public.mark_read(uuid), public.mark_delivered(uuid[]), public.mark_unread(uuid), public.clear_chat(uuid, boolean),
  public.my_unread_counts(), public.recent_messages(integer), public.username_available(text)
  to authenticated;
grant execute on function public.username_available(text) to anon;
-- Used inside row-level policies, so the signed-in role must be able to run them.
grant execute on function
  public.is_member(uuid, boolean), public.is_admin(uuid), public.can_see_message(uuid, timestamptz, timestamptz),
  public.is_blocked_in(uuid), public.audience_ok(text, uuid), public.can_use_media(text, boolean), public.can_edit_info(uuid)
  to authenticated;
revoke execute on function public.sys_message(uuid, text, uuid[], text, jsonb), public.profile_view(uuid[]),
  public.name_of(uuid), public.handle_new_user(), public.prepare_message(), public.after_message()
  from authenticated;

-- =====================================================================
-- Storage: chat media (private, members only) and profile photos.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit)
  values ('chat-media', 'chat-media', false, 26214400)
  on conflict (id) do update set public = false, file_size_limit = 26214400;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = false;

create policy "chat-media: members read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.can_use_media(name, false));
create policy "chat-media: members upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and public.can_use_media(name, true));
create policy "chat-media: uploader deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and owner = auth.uid());

-- Photo file names are random, and the path is only handed out by
-- get_profiles() to people allowed to see the photo.
create policy "avatars: signed-in read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars');
create policy "avatars: owner uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);
create policy "avatars: owner updates" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);
create policy "avatars: owner deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);

-- =====================================================================
-- Realtime: new messages, edits, reactions, receipts, group changes.
-- Realtime applies the read policies above to every event.
-- =====================================================================
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table public.messages, public.conversation_members, public.conversations;

-- Typing indicators use private broadcast channels named
-- "typing:<conversation id>"; only members may join.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy "typing: members only" on realtime.messages for all to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and (select realtime.topic()) like 'typing:%'
        and public.can_use_media(substr((select realtime.topic()), 8), true)
      )
      with check (
        realtime.messages.extension = 'broadcast'
        and (select realtime.topic()) like 'typing:%'
        and public.can_use_media(substr((select realtime.topic()), 8), true)
      )
    $p$;
  end if;
end $$;
