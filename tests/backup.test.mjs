// Tests the backup and restore scripts against a fake Supabase client:
// paging, missing tables, storage listing, retention and the restore upserts.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBackup, pruneOld, planPrune, fetchAll, listBucket, TABLES } from '../scripts/backup.mjs';
import { restore, tablesToRestore } from '../scripts/restore.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log('  ok', name); };
const quiet = () => {};

function fakeClient({ rows = {}, missing = [], buckets = {} } = {}) {
  const calls = { ranges: [], upserts: [] };
  const client = {
    from(table) {
      const q = {
        select: () => q,
        range: async (from, to) => {
          calls.ranges.push([table, from, to]);
          if (missing.includes(table)) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
          return { data: (rows[table] || []).slice(from, to + 1), error: null };
        },
        upsert: async (chunk, opts) => { calls.upserts.push([table, chunk.length, opts?.onConflict]); return { error: null }; },
      };
      return q;
    },
    storage: {
      from(bucket) {
        return {
          list: async (prefix, { offset }) => ({ data: offset ? [] : (buckets[bucket]?.[prefix] || []), error: null }),
          download: async (p) => ({ data: new Blob([`file:${p}`]), error: null }),
        };
      },
    },
  };
  return { client, calls };
}

// ---- paging and missing tables
const many = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
let fake = fakeClient({ rows: { shots: many }, missing: ['refs'] });
let got = await fetchAll(fake.client, 'shots');
assert.equal(got.rows.length, 2300);
assert.deepEqual(fake.calls.ranges.map(([, f]) => f), [0, 1000, 2000]);
got = await fetchAll(fake.client, 'refs');
assert.deepEqual(got.rows, []);
assert.match(got.skipped, /does not exist/);
ok('every row is read in pages; a table from a migration not run yet is skipped, not fatal');

// ---- storage listing walks folders
fake = fakeClient({ buckets: { media: {
  '': [{ name: '2026', id: null }],
  '2026': [{ name: '09', id: null }],
  '2026/09': [{ name: 'a.webp', id: 'x', metadata: { size: 1234, mimetype: 'image/webp' }, updated_at: '2026-09-01T00:00:00Z' }],
} } });
assert.deepEqual(await listBucket(fake.client, 'media'), [{ path: '2026/09/a.webp', size: 1234, mime: 'image/webp', updated_at: '2026-09-01T00:00:00Z' }]);
ok('storage listing walks folders and records path, size and type');

// ---- a full backup run
const out = await mkdtemp(path.join(tmpdir(), 'pt-backup-'));
fake = fakeClient({
  rows: {
    shots: [{ id: 's1', shot_name: 'SQ010_0010' }], dailies: [{ id: 'd1', transcript: 'Sascha: hello' }], todos: [{ id: 't1' }],
    sequences: [{ code: 'SQ010', title: 'Harbour' }],
  },
  missing: ['refs'],
  buckets: { references: { '': [{ name: 'clip.mp4', id: 'y', metadata: { size: 2_000_000, mimetype: 'video/mp4' } }] } },
});
const manifest = await runBackup({ client: fake.client, outDir: out, today: '2026-09-23', downloadFiles: true, log: quiet });
const dir = path.join(out, '2026-09-23');
const files = await readdir(dir);
for (const t of TABLES.filter((x) => x !== 'refs')) assert.ok(files.includes(`${t}.json`), `${t}.json missing`);
assert.ok(!files.includes('refs.json'));
assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'shots.json'), 'utf8')), [{ id: 's1', shot_name: 'SQ010_0010' }]);
assert.match(await readFile(path.join(dir, 'dailies.json'), 'utf8'), /Sascha: hello/);
assert.deepEqual(manifest.buckets.references, { files: 1, bytes: 2_000_000 });
assert.equal(manifest.tables.refs.rows, 0);
assert.match(manifest.tables.refs.skipped, /does not exist/);
assert.equal(await readFile(path.join(dir, 'files', 'references', 'clip.mp4'), 'utf8'), 'file:clip.mp4');
assert.ok(manifest.finished_at >= manifest.started_at);
ok('a backup writes one file per table, the storage listing, the files and a manifest');

// ---- retention
const dates = [
  '2025-06-01', '2025-06-18', '2025-11-01', '2025-11-14', '2025-12-01', '2025-12-20',
  '2026-08-01', '2026-08-15', '2026-08-30',
  '2026-09-01', '2026-09-10', '2026-09-20', '2026-09-22', '2026-09-23',
];
const dropped = planPrune(dates, '2026-09-23');
assert.ok(dropped.includes('2025-11-14') && dropped.includes('2025-12-20') && dropped.includes('2026-08-15'));
assert.ok(!dropped.includes('2026-08-30'), 'the last 30 days are kept in full');
assert.ok(!dropped.includes('2026-09-23') && !dropped.includes('2026-09-01') && !dropped.includes('2026-08-01'));
assert.ok(!dropped.includes('2025-12-01'), 'monthly copies stay for a year');
assert.ok(dropped.includes('2025-06-01') && dropped.includes('2025-06-18'), 'anything older than a year goes');
assert.ok(!dropped.includes('2025-11-01'), 'the monthly copy of each of the last 12 months stays');
for (const d of dates) await mkdir(path.join(out, d), { recursive: true });
await writeFile(path.join(out, 'README.md'), 'not a backup');
const removed = await pruneOld({ outDir: out, today: '2026-09-23', log: quiet });
assert.deepEqual(removed, dropped);
assert.ok((await readdir(out)).includes('README.md'), 'other files are left alone');
ok('retention keeps 30 days of backups plus one per month for a year');

// ---- restore
assert.deepEqual(tablesToRestore({}), TABLES.filter((t) => !['profiles', 'admin_emails'].includes(t)));
assert.deepEqual(tablesToRestore({ only: 'shots,todos' }), ['shots', 'todos']);
assert.ok(tablesToRestore({ withProfiles: true }).includes('profiles'));
fake = fakeClient();
const plan = await restore({ client: fake.client, dir, tables: ['shots', 'todos', 'refs'], write: false, log: quiet });
assert.deepEqual(plan, { shots: 1, todos: 1 });
assert.deepEqual(fake.calls.upserts, [], 'a dry run writes nothing');
await restore({ client: fake.client, dir, tables: ['project_settings', 'sequences', 'shots'], write: true, log: quiet });
assert.deepEqual(fake.calls.upserts.map(([t, , key]) => `${t}:${key}`), ['sequences:code', 'shots:id'], 'each table by its own key');

ok('restore is a dry run by default, writes by primary key, and ignores tables missing from the backup');

console.log(`backup: ${passed} checks passed`);
