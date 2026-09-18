// Runs supabase/schema.sql against an in-process Postgres (PGlite) with
// minimal stand-ins for Supabase's auth/storage schemas, then checks the
// row-level security rules as different users.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite();

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key, email text, email_confirmed_at timestamptz,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(),
    bucket_id text, name text);
  alter table storage.objects enable row level security;
  create publication supabase_realtime;
  grant usage on schema public, storage to authenticated, anon;
  alter default privileges in schema public grant all on tables to authenticated, anon;
  grant all on storage.objects to authenticated;
`);

const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
  .replaceAll('ADMIN_EMAIL_HERE', 'boss@example.com');
await db.exec(sql);
await db.exec(sql); // idempotent

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const MEMBER = '00000000-0000-0000-0000-00000000000b';
const FAKE = '00000000-0000-0000-0000-00000000000c';
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
    ('${ADMIN}', 'Boss@example.com', now(), '{"display_name":"Sascha"}'),
    ('${MEMBER}', 'crew@example.com', now(), '{}'),
    ('${FAKE}', 'x@example.com', null, '{}');
`);

async function as(uid, q, params) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${uid ?? ''}'; set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await db.query(q, params); }
  finally { await db.exec('reset role;'); }
}
async function fails(uid, q) {
  try { await as(uid, q); } catch (e) { return e.message; }
  assert.fail(`expected failure: ${q}`);
}

let passed = 0;
const ok = (name) => { passed++; console.log('  ok', name); };

// profile bootstrap
let r = await db.query(`select id, role, approved, display_name from public.profiles order by email`);
assert.equal(r.rows.length, 3);
const admin = r.rows.find((x) => x.id === ADMIN);
assert.equal(admin.role, 'admin'); assert.equal(admin.approved, true); assert.equal(admin.display_name, 'Sascha');
assert.equal(r.rows.find((x) => x.id === MEMBER).approved, false);
ok('admin bootstrapped by email, others pending');

// unapproved member sees nothing
r = await as(MEMBER, 'select * from public.shots'); assert.equal(r.rows.length, 0);
await fails(MEMBER, `insert into public.shots (shot_name) values ('x')`);
r = await as(MEMBER, 'select * from public.profiles'); assert.equal(r.rows.length, 1);
ok('pending user blocked from data, sees only own profile');

// pending user cannot self-approve
await fails(MEMBER, `update public.profiles set approved = true where id = '${MEMBER}'`);
await as(MEMBER, `update public.profiles set display_name = 'Crew' where id = '${MEMBER}'`);
r = await db.query(`select display_name, approved from public.profiles where id = '${MEMBER}'`);
assert.deepEqual(r.rows[0], { display_name: 'Crew', approved: false });
ok('self-approval rejected, display name editable');

// anon has no access
await fails(null, 'select * from public.shots');
await fails(null, 'select * from public.profiles');
ok('anon locked out');

// admin approves member
await as(ADMIN, `update public.profiles set approved = true where id = '${MEMBER}'`);
await fails(ADMIN, `update public.profiles set role = 'member' where id = '${ADMIN}'`);
ok('admin approves others, cannot demote self');

// member works with data
await as(MEMBER, `insert into public.shots (shot_name, frame_in, frame_out, assignee) values ('010_0010', 1001, 1096, 'Mihai')`);
r = await as(MEMBER, 'select duration, created_by from public.shots');
assert.equal(r.rows[0].duration, 96); assert.equal(r.rows[0].created_by, MEMBER);
await fails(MEMBER, `insert into public.shots (frame_in, frame_out) values (10, 5)`);
await fails(MEMBER, `insert into public.shots (status) values ('bogus')`);
ok('shots: insert, duration, audit fields, constraints');

const shotId = (await db.query('select id from public.shots')).rows[0].id;
await as(MEMBER, `insert into public.todos (shot_id, person, body) values ('${shotId}', 'Rafael', 'Roto hair')`);
await fails(MEMBER, `insert into public.todos (person, body) values ('Nobody', 'x')`);
await as(MEMBER, `insert into public.dailies (title, content) values ('Day 1', '<p>hi</p>')`);
r = await as(MEMBER, 'select count(*)::int n from public.dailies'); assert.equal(r.rows[0].n, 1);
ok('todos restricted to team members, dailies writable');

// settings / team only by admin
await fails(MEMBER, `insert into public.team_members (name) values ('Eve')`);
r = await as(MEMBER, `update public.project_settings set fps = 25 returning *`); assert.equal(r.rows.length, 0);
r = await as(ADMIN, `update public.project_settings set fps = 25 returning fps`); assert.equal(Number(r.rows[0].fps), 25);
ok('settings and team editable by admin only');

// unconfirmed email never counts as approved, even if flagged
await db.exec(`update public.profiles set approved = true where id = '${FAKE}'`);
r = await as(FAKE, 'select * from public.shots'); assert.equal(r.rows.length, 0);
ok('unconfirmed email blocked even when approved');

// storage
await as(MEMBER, `insert into storage.objects (bucket_id, name) values ('media', 'a.png')`);
r = await as(MEMBER, `delete from storage.objects returning 1`); assert.equal(r.rows.length, 0);
r = await as(ADMIN, `delete from storage.objects returning 1`); assert.equal(r.rows.length, 1);
r = await db.query(`select public from storage.buckets where id = 'media'`); assert.equal(r.rows[0].public, false);
ok('storage bucket private, delete admin-only');

// cascade
await as(MEMBER, `delete from public.shots where id = '${shotId}'`);
r = await db.query('select count(*)::int n from public.todos'); assert.equal(r.rows[0].n, 0);
ok('deleting a shot removes its todos');

console.log(`schema: ${passed} checks passed`);
