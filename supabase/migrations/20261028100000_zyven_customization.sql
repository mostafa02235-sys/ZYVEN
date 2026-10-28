-- ZYVEN customization: profile picture frames and per-chat wallpapers.
--
-- * profiles.frame: the frame someone picked. Other signed-in people see it
--   through get_profiles()/search_profiles(), like the rest of the profile.
--   Only the owner can change it (column grant + the existing
--   "profiles: owner updates" policy). The frame is drawn by the app on top
--   of the photo; the uploaded photo itself is never changed.
-- * chat_wallpapers: one row per (person, conversation). Private: only the
--   person who set it can read or change it. A wallpaper is a solid colour,
--   an image, or a video (with an optional still "poster" as fallback).
-- * Storage bucket "wallpapers": private; every file lives in a folder named
--   after its owner's user id and only that person can read or write it.

-- ---------- Profile frames ----------
alter table public.profiles add column if not exists frame text
  check (frame is null or frame ~ '^[a-z0-9-]{1,32}$');
grant update (frame) on public.profiles to authenticated;

-- The profile read functions gain a "frame" column. Return types can't be
-- changed in place, so they are recreated with the same rules as before.
drop function if exists public.search_profiles(text);
drop function if exists public.get_profiles(uuid[]);
drop function if exists public.profile_view(uuid[]);

create function public.profile_view(ids uuid[])
returns table (
  id uuid, username text, display_name text, bio text, hue integer,
  avatar_path text, online boolean, last_seen_at timestamptz, read_receipts boolean, frame text
)
language sql stable security definer set search_path = '' as $$
  with me as (select p.privacy_last_seen as my_last_seen from public.profiles p where p.id = auth.uid())
  select p.id, p.username, p.display_name, p.bio, p.hue,
    case when public.audience_ok(p.privacy_photo, p.id) then p.avatar_path end,
    (p.last_seen_at > now() - interval '2 minutes' and public.audience_ok(p.privacy_online, p.id)),
    case when p.id = auth.uid()
           or (public.audience_ok(p.privacy_last_seen, p.id) and coalesce((select my_last_seen from me), 'everyone') <> 'nobody')
         then p.last_seen_at end,
    p.read_receipts,
    p.frame
  from public.profiles p
  where auth.uid() is not null and p.id = any (ids);
$$;

create function public.get_profiles(ids uuid[])
returns table (
  id uuid, username text, display_name text, bio text, hue integer,
  avatar_path text, online boolean, last_seen_at timestamptz, read_receipts boolean, frame text
)
language sql stable security definer set search_path = '' as $$
  select * from public.profile_view(ids[1:500]);
$$;

create function public.search_profiles(q text)
returns table (
  id uuid, username text, display_name text, bio text, hue integer,
  avatar_path text, online boolean, last_seen_at timestamptz, read_receipts boolean, frame text
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

revoke execute on function public.profile_view(uuid[]), public.get_profiles(uuid[]), public.search_profiles(text) from public, anon;
revoke execute on function public.profile_view(uuid[]) from authenticated;
grant execute on function public.get_profiles(uuid[]), public.search_profiles(text) to authenticated;

-- ---------- Chat wallpapers ----------
create table if not exists public.chat_wallpapers (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kind text not null check (kind in ('color', 'image', 'video')),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  path text check (path is null or char_length(path) <= 200),
  poster_path text check (poster_path is null or char_length(poster_path) <= 200),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id),
  -- Files must sit in the owner's own folder.
  check (path is null or split_part(path, '/', 1) = user_id::text),
  check (poster_path is null or split_part(poster_path, '/', 1) = user_id::text),
  check ((kind = 'color' and color is not null) or (kind in ('image', 'video') and path is not null))
);
alter table public.chat_wallpapers enable row level security;
drop policy if exists "wallpapers: owner reads" on public.chat_wallpapers;
drop policy if exists "wallpapers: owner sets" on public.chat_wallpapers;
drop policy if exists "wallpapers: owner changes" on public.chat_wallpapers;
drop policy if exists "wallpapers: owner removes" on public.chat_wallpapers;
create policy "wallpapers: owner reads" on public.chat_wallpapers for select to authenticated
  using (user_id = (select auth.uid()));
create policy "wallpapers: owner sets" on public.chat_wallpapers for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_member(conversation_id));
create policy "wallpapers: owner changes" on public.chat_wallpapers for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_member(conversation_id));
create policy "wallpapers: owner removes" on public.chat_wallpapers for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.chat_wallpapers from anon;
grant select, insert, update, delete on public.chat_wallpapers to authenticated;

drop trigger if exists chat_wallpapers_touch on public.chat_wallpapers;
create trigger chat_wallpapers_touch before update on public.chat_wallpapers
  for each row execute function public.touch_updated_at();

-- ---------- Storage: private wallpaper files ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('wallpapers', 'wallpapers', false, 52428800,
          array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'])
  on conflict (id) do update set public = false, file_size_limit = 52428800,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'];

drop policy if exists "wallpapers: owner reads files" on storage.objects;
drop policy if exists "wallpapers: owner uploads files" on storage.objects;
drop policy if exists "wallpapers: owner updates files" on storage.objects;
drop policy if exists "wallpapers: owner deletes files" on storage.objects;
create policy "wallpapers: owner reads files" on storage.objects for select to authenticated
  using (bucket_id = 'wallpapers' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy "wallpapers: owner uploads files" on storage.objects for insert to authenticated
  with check (bucket_id = 'wallpapers' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy "wallpapers: owner updates files" on storage.objects for update to authenticated
  using (bucket_id = 'wallpapers' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy "wallpapers: owner deletes files" on storage.objects for delete to authenticated
  using (bucket_id = 'wallpapers' and split_part(name, '/', 1) = (select auth.uid())::text);
