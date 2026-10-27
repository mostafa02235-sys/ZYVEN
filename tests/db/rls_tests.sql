\set ON_ERROR_STOP 1
\pset tuples_only on
\o /dev/null
-- Test accounts: A (alice), B (bob), C (carol).
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test', '{"username":"alice","display_name":"Alice A"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test', '{"username":"bob.b","display_name":"Bob B"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'c@test', '{"username":"carol_c","display_name":"Carol C"}');

create or replace function pg_temp.act(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); end $$;
create table public._results (n serial, name text, ok boolean, detail text);
grant all on public._results to authenticated, anon; grant usage on sequence public._results_n_seq to authenticated, anon;
create or replace function public._ok(name text, cond boolean, detail text default '') returns void language sql as $$
  insert into public._results (name, ok, detail) values (name, cond, detail) $$;
grant execute on function public._ok(text, boolean, text) to authenticated, anon;

-- Sign-up rules
do $$ begin
  begin insert into auth.users (email, raw_user_meta_data) values ('d@test', '{"username":"alice"}');
        perform _ok('duplicate username rejected', false);
  exception when others then perform _ok('duplicate username rejected', sqlerrm like '%USERNAME_TAKEN%', sqlerrm); end;
  begin insert into auth.users (email, raw_user_meta_data) values ('e@test', '{"username":"No Spaces!"}');
        perform _ok('invalid username rejected', false);
  exception when others then perform _ok('invalid username rejected', sqlerrm like '%USERNAME_INVALID%', sqlerrm); end;
  perform _ok('profiles created for 3 users', (select count(*) from profiles) = 3);
end $$;

set role anon;
select _ok('anon: username_available works', username_available('newname') and not username_available('alice'));
do $$ begin
  begin perform * from messages; perform _ok('anon cannot read messages', false);
  exception when insufficient_privilege then perform _ok('anon cannot read messages', true); end;
  begin perform search_profiles('bo'); perform _ok('anon cannot search', false);
  exception when insufficient_privilege then perform _ok('anon cannot search', true); end;
end $$;
reset role;

-- A: search, contacts, direct chat
select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
select _ok('search finds bob by username', exists (select 1 from search_profiles('bo') where username = 'bob.b'));
select _ok('search finds by display name', exists (select 1 from search_profiles('carol c') where username = 'carol_c'));
select _ok('search never returns yourself', not exists (select 1 from search_profiles('ali')));
select _ok('search with @ prefix', exists (select 1 from search_profiles('@bob') where username = 'bob.b'));
select _ok('search wildcard is literal', not exists (select 1 from search_profiles('%')));
select _ok('search no match → empty', not exists (select 1 from search_profiles('zzzz')));
select _ok('cannot read other profile rows directly', (select count(*) from profiles) = 1);
insert into contacts (contact_id) values ('bbbbbbbb-0000-0000-0000-000000000002');
do $$ begin
  begin insert into contacts (contact_id) values ('bbbbbbbb-0000-0000-0000-000000000002'); perform _ok('duplicate contact rejected', false);
  exception when unique_violation then perform _ok('duplicate contact rejected', true); end;
  begin insert into contacts (contact_id) values ('aaaaaaaa-0000-0000-0000-000000000001'); perform _ok('self contact rejected', false);
  exception when check_violation then perform _ok('self contact rejected', true); end;
  begin insert into contacts (owner_id, contact_id) values ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002'); perform _ok('cannot add contacts for others', false);
  exception when insufficient_privilege then perform _ok('cannot add contacts for others', true); end;
  begin perform get_or_create_direct('aaaaaaaa-0000-0000-0000-000000000001'); perform _ok('cannot chat with self', false);
  exception when others then perform _ok('cannot chat with self', sqlerrm like '%SELF%'); end;
  begin perform get_or_create_direct('dddddddd-0000-0000-0000-000000000009'); perform _ok('cannot chat with unknown user', false);
  exception when others then perform _ok('cannot chat with unknown user', sqlerrm like '%NOT_FOUND%'); end;
end $$;
create temp table t_conv as select get_or_create_direct('bbbbbbbb-0000-0000-0000-000000000002') as id;
select _ok('direct chat is not duplicated', get_or_create_direct('bbbbbbbb-0000-0000-0000-000000000002') = (select id from t_conv));
insert into messages (id, conversation_id, kind, body) select '11111111-0000-0000-0000-000000000001', id, 'text', 'hello bob' from t_conv;
select _ok('A sees own message', (select count(*) from messages) = 1);
do $$ begin
  begin insert into messages (conversation_id, sender_id, kind, body) select id, 'bbbbbbbb-0000-0000-0000-000000000002', 'text', 'spoof' from t_conv; perform _ok('cannot send as someone else', false);
  exception when insufficient_privilege then perform _ok('cannot send as someone else', true); end;
  begin insert into messages (conversation_id, kind, body) select id, 'system', 'fake system' from t_conv; perform _ok('cannot send system messages', false);
  exception when insufficient_privilege then perform _ok('cannot send system messages', true); end;
  begin insert into messages (conversation_id, kind, body, created_at) select id, 'text', 'x', now() - interval '1 day' from t_conv; perform _ok('cannot backdate messages', false);
  exception when insufficient_privilege then perform _ok('cannot backdate messages', true); end;
  begin update messages set body = 'hacked'; perform _ok('no direct updates', false);
  exception when insufficient_privilege then perform _ok('no direct updates', true); end;
  begin delete from messages; perform _ok('no direct deletes', false);
  exception when insufficient_privilege then perform _ok('no direct deletes', true); end;
  begin insert into messages (conversation_id, kind, body) select id, 'text', '   ' from t_conv; perform _ok('empty text rejected', false);
  exception when check_violation then perform _ok('empty text rejected', true); end;
end $$;
grant select on t_conv to authenticated;
reset role;
create table public._conv as select * from t_conv; grant select on public._conv to authenticated;

-- C: outsider
select pg_temp.act('cccccccc-0000-0000-0000-000000000003');
set role authenticated;
select _ok('outsider sees no messages', (select count(*) from messages) = 0);
select _ok('outsider sees no conversation', (select count(*) from conversations) = 0);
select _ok('outsider sees no members', (select count(*) from conversation_members) = 0);
select _ok('outsider gets no recent_messages', (select count(*) from recent_messages(50)) = 0);
do $$ begin
  begin insert into messages (conversation_id, kind, body) select id, 'text', 'intrude' from _conv; perform _ok('outsider cannot post', false);
  exception when insufficient_privilege then perform _ok('outsider cannot post', true); end;
  begin perform toggle_reaction('11111111-0000-0000-0000-000000000001', '👍'); perform _ok('outsider cannot react', false);
  exception when others then perform _ok('outsider cannot react', sqlerrm like '%CANNOT_REACT%'); end;
  begin perform delete_message('11111111-0000-0000-0000-000000000001'); perform _ok('outsider cannot delete', false);
  exception when others then perform _ok('outsider cannot delete', sqlerrm like '%CANNOT_DELETE%'); end;
  begin perform toggle_pin((select id from _conv), '11111111-0000-0000-0000-000000000001'); perform _ok('outsider cannot pin', false);
  exception when others then perform _ok('outsider cannot pin', sqlerrm like '%ADMINS_ONLY%'); end;
end $$;
do $$ begin
  begin insert into storage.objects (bucket_id, name) values ('chat-media', 'cccccccc-0000-0000-0000-000000000003/x/evil.jpg'); perform _ok('outsider upload to non-conversation folder blocked', false);
  exception when insufficient_privilege then perform _ok('outsider upload to non-conversation folder blocked', true); end;
  begin insert into storage.objects (bucket_id, name) select 'chat-media', id || '/x/evil.jpg' from _conv; perform _ok('outsider upload into others chat blocked', false);
  exception when insufficient_privilege then perform _ok('outsider upload into others chat blocked', true); end;
  perform _ok('outsider cannot list chat media', (select count(*) from storage.objects where bucket_id = 'chat-media') = 0);
end $$;
reset role;

-- B: recipient
select pg_temp.act('bbbbbbbb-0000-0000-0000-000000000002');
set role authenticated;
select _ok('B receives A message', (select body from messages where id = '11111111-0000-0000-0000-000000000001') = 'hello bob');
select _ok('B unread count is 1', (select unread from my_unread_counts() where conversation_id = (select id from _conv)) = 1);
select mark_read((select id from _conv));
select _ok('B unread count is 0 after reading', not exists (select 1 from my_unread_counts() where unread > 0));
select _ok('B read receipt visible', (select read_at is not null from conversation_members where user_id = auth.uid()));
do $$ begin
  begin perform edit_message('11111111-0000-0000-0000-000000000001', 'changed'); perform _ok('B cannot edit A message', false);
  exception when others then perform _ok('B cannot edit A message', sqlerrm like '%CANNOT_EDIT%'); end;
  begin perform delete_message('11111111-0000-0000-0000-000000000001'); perform _ok('B cannot delete A message', false);
  exception when others then perform _ok('B cannot delete A message', sqlerrm like '%CANNOT_DELETE%'); end;
end $$;
select toggle_reaction('11111111-0000-0000-0000-000000000001', '❤️');
select _ok('reaction stored', (select reactions -> '❤️' ? 'bbbbbbbb-0000-0000-0000-000000000002' from messages where id = '11111111-0000-0000-0000-000000000001'));
select toggle_reaction('11111111-0000-0000-0000-000000000001', '👍');
select _ok('one reaction per person', (select reactions = '{"👍": ["bbbbbbbb-0000-0000-0000-000000000002"]}'::jsonb from messages where id = '11111111-0000-0000-0000-000000000001'));
select toggle_reaction('11111111-0000-0000-0000-000000000001', '👍');
select _ok('same emoji removes reaction', (select reactions = '{}'::jsonb from messages where id = '11111111-0000-0000-0000-000000000001'));
insert into messages (conversation_id, kind, body) select id, 'text', 'hi alice' from _conv;
insert into storage.objects (bucket_id, name) select 'chat-media', id || '/m1/photo.jpg' from _conv;
update profiles set privacy_photo = 'nobody', avatar_path = 'bbbbbbbb-0000-0000-0000-000000000002/r.jpg' where id = auth.uid();
do $$ begin
  begin update profiles set display_name = 'Hacked' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    perform _ok('cannot edit someone else profile', (select count(*) from profiles where display_name = 'Hacked') = 0);
  exception when insufficient_privilege then perform _ok('cannot edit someone else profile', true); end;
  begin update profiles set last_seen_at = now() - interval '1 year' where id = auth.uid(); perform _ok('cannot write presence directly', false);
  exception when insufficient_privilege then perform _ok('cannot write presence directly', true); end;
end $$;
reset role;
select _ok('member upload into conversation folder allowed', exists (select 1 from storage.objects where name like '%/m1/photo.jpg'));
-- B blocks A
select pg_temp.act('bbbbbbbb-0000-0000-0000-000000000002'); set role authenticated;
insert into blocks (blocked_id) values ('aaaaaaaa-0000-0000-0000-000000000001');
reset role;

select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001'); set role authenticated;
select _ok('A sees B reply', exists (select 1 from messages where body = 'hi alice'));
select _ok('A sees B read receipt', (select read_at is not null from conversation_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'));
select _ok('photo privacy hides avatar', (select avatar_path is null from get_profiles(array['bbbbbbbb-0000-0000-0000-000000000002'::uuid])));
select _ok('A can read media in shared chat', (select count(*) from storage.objects where bucket_id = 'chat-media') = 1);
do $$ begin
  begin insert into messages (conversation_id, kind, body) select id, 'text', 'are you there?' from _conv; perform _ok('blocked person cannot send', false);
  exception when insufficient_privilege then perform _ok('blocked person cannot send', true); end;
end $$;
select edit_message('11111111-0000-0000-0000-000000000001', 'hello bob (edited)');
select _ok('sender can edit', (select edited_at is not null from messages where id = '11111111-0000-0000-0000-000000000001'));
select toggle_pin((select id from _conv), '11111111-0000-0000-0000-000000000001');
select _ok('pin stored', (select '11111111-0000-0000-0000-000000000001'::uuid = any (pins) from conversations where id = (select id from _conv)));
select delete_message('11111111-0000-0000-0000-000000000001');
select _ok('sender can delete for everyone', (select deleted_at is not null and body is null from messages where id = '11111111-0000-0000-0000-000000000001'));
select _ok('deleting unpins', (select cardinality(pins) = 0 from conversations where id = (select id from _conv)));

-- Groups
create temp table t_group as select create_group('Weekend', 'plans', '{"kind":"hue","hue":95}', array['bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003']::uuid[]) as id;
grant select on t_group to authenticated;
reset role; create table public._grp as select * from t_group; grant select on public._grp to authenticated;
select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001'); set role authenticated;
insert into messages (conversation_id, kind, body) select id, 'text', 'group hello' from _grp;
reset role;

select pg_temp.act('cccccccc-0000-0000-0000-000000000003'); set role authenticated;
select _ok('group member sees group message', exists (select 1 from messages where body = 'group hello'));
select _ok('group member sees system messages', (select count(*) from messages where kind = 'system' and conversation_id = (select id from _grp)) = 2);
select _ok('C still cannot see the A–B chat', not exists (select 1 from messages where conversation_id = (select id from _conv)));
do $$ begin
  begin perform add_members((select id from _grp), array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[]); perform _ok('non-admin cannot add members', false);
  exception when others then perform _ok('non-admin cannot add members', sqlerrm like '%ADMINS_ONLY%'); end;
  begin perform remove_member((select id from _grp), 'aaaaaaaa-0000-0000-0000-000000000001'); perform _ok('non-admin cannot remove members', false);
  exception when others then perform _ok('non-admin cannot remove members', sqlerrm like '%ADMINS_ONLY%'); end;
  begin perform set_admin((select id from _grp), 'cccccccc-0000-0000-0000-000000000003', true); perform _ok('non-admin cannot promote self', false);
  exception when others then perform _ok('non-admin cannot promote self', sqlerrm like '%ADMINS_ONLY%'); end;
end $$;
select update_group((select id from _grp), 'Weekend trip', 'plans', null);
select _ok('member can edit info when allowed', (select title from conversations where id = (select id from _grp)) = 'Weekend trip');
reset role;

select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001'); set role authenticated;
select set_edit_info((select id from _grp), 'admins');
select remove_member((select id from _grp), 'cccccccc-0000-0000-0000-000000000003');
insert into messages (conversation_id, kind, body) select id, 'text', 'after removal' from _grp;
reset role;

select pg_temp.act('cccccccc-0000-0000-0000-000000000003'); set role authenticated;
select _ok('removed member keeps old history', exists (select 1 from messages where body = 'group hello'));
select _ok('removed member cannot see new messages', not exists (select 1 from messages where body = 'after removal'));
do $$ begin
  begin insert into messages (conversation_id, kind, body) select id, 'text', 'still here?' from _grp; perform _ok('removed member cannot post', false);
  exception when insufficient_privilege then perform _ok('removed member cannot post', true); end;
  begin perform update_group((select id from _grp), 'Mine now', '', null); perform _ok('removed member cannot edit group', false);
  exception when others then perform _ok('removed member cannot edit group', sqlerrm like '%ADMINS_ONLY%'); end;
end $$;
reset role;

select pg_temp.act('bbbbbbbb-0000-0000-0000-000000000002'); set role authenticated;
do $$ begin
  begin perform update_group((select id from _grp), 'B rename', '', null); perform _ok('edit_info=admins blocks members', false);
  exception when others then perform _ok('edit_info=admins blocks members', sqlerrm like '%ADMINS_ONLY%'); end;
end $$;
select leave_group((select id from _grp));
reset role;
select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001'); set role authenticated;
select leave_group((select id from _grp));
reset role;
select _ok('group has no active members left', (select count(*) from conversation_members where conversation_id = (select id from _grp) and left_at is null) = 0);

-- Admin hand-over
select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001'); set role authenticated;
create temp table t_g2 as select create_group('Handover', '', null, array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[]) as id;
select leave_group((select id from t_g2));
reset role;
select _ok('last admin leaving promotes someone', (select role from conversation_members where conversation_id = (select id from t_g2) and user_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'admin');

-- Disappearing messages
select pg_temp.act('cccccccc-0000-0000-0000-000000000003'); set role authenticated;
create temp table t_cd as select get_or_create_direct('aaaaaaaa-0000-0000-0000-000000000001') as id;
select set_ttl((select id from t_cd), '1m');
insert into messages (conversation_id, kind, body) select id, 'text', 'vanishing' from t_cd;
select _ok('ttl sets expiry', (select expires_at is not null from messages where body = 'vanishing'));
reset role;
update messages set expires_at = now() - interval '1 second' where body = 'vanishing';
select pg_temp.act('cccccccc-0000-0000-0000-000000000003'); set role authenticated;
select _ok('expired message hidden', not exists (select 1 from messages where body = 'vanishing'));
-- Clear / hide
select clear_chat((select id from t_cd), true);
select _ok('hidden chat flagged', (select hidden from member_state where conversation_id = (select id from t_cd)));
reset role;
select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001'); set role authenticated;
insert into messages (conversation_id, kind, body) select id, 'text', 'wake up' from t_cd;
reset role;
select _ok('new message un-hides chat', not (select hidden from member_state where conversation_id = (select id from t_cd) and user_id = 'cccccccc-0000-0000-0000-000000000003'));

-- Typing channel policy
select pg_temp.act('cccccccc-0000-0000-0000-000000000003');
select set_config('realtime.topic', 'typing:' || (select id from _conv), false);
set role authenticated;
select _ok('outsider cannot join typing channel', not public.can_use_media(substr((select realtime.topic()), 8), true));
reset role;
select pg_temp.act('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
select _ok('member can join typing channel', public.can_use_media(substr((select realtime.topic()), 8), true));
reset role;

\o
\pset tuples_only off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, left(detail, 80) as detail from public._results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from public._results;
