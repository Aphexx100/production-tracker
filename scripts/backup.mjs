// Full backup of the Supabase project data to JSON files.
//
//   node scripts/backup.mjs --out backups            (data only)
//   node scripts/backup.mjs --out backups --files    (also download stored files)
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. The
// service key bypasses row-level security, so it belongs in a GitHub Actions
// secret or a local .env.backup — never in the app or this repository.
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Restore order matters: a table is listed after everything it points at.
export const TABLES = [
  'project_settings', 'team_members', 'admin_emails', 'profiles',
  'sequences', 'shots', 'dailies', 'milestones', 'todos', 'refs',
];
export const BUCKETS = ['media', 'references'];
const PAGE = 1000;

/** Read a whole table, in pages, so large projects come out complete. */
export async function fetchAll(client, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select('*').range(from, from + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return { rows: [], skipped: error.message };
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...data);
    if (data.length < PAGE) return { rows };
  }
}

/** Every object in a bucket, walking its folders. */
export async function listBucket(client, bucket, prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: PAGE, offset });
    if (error) {
      if (/not found/i.test(error.message)) return out;
      throw new Error(`${bucket}: ${error.message}`);
    }
    for (const entry of data) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null && !entry.metadata) out.push(...await listBucket(client, bucket, full)); // folder
      else out.push({ path: full, size: entry.metadata?.size ?? null, mime: entry.metadata?.mimetype ?? null, updated_at: entry.updated_at ?? null });
    }
    if (data.length < PAGE) return out;
  }
}

/** Keep every backup of the last 30 days, plus the first of each month for a year. */
export function planPrune(dates, today, { keepDays = 30, keepMonths = 12 } = {}) {
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const now = day(today);
  const firstOfMonth = new Map();
  for (const d of [...dates].sort()) {
    const key = d.slice(0, 7);
    if (!firstOfMonth.has(key)) firstOfMonth.set(key, d);
  }
  const monthly = new Set([...firstOfMonth.entries()]
    .filter(([key]) => (now - day(`${key}-01`)) / 30.4 < keepMonths)
    .map(([, d]) => d));
  return dates.filter((d) => now - day(d) > keepDays && !monthly.has(d)).sort();
}

export async function runBackup({ client, outDir, today, downloadFiles = false, log = console.log }) {
  const dir = path.join(outDir, today);
  await mkdir(dir, { recursive: true });
  const manifest = { date: today, started_at: new Date().toISOString(), tables: {}, buckets: {}, files_downloaded: downloadFiles };

  for (const table of TABLES) {
    const { rows, skipped } = await fetchAll(client, table);
    if (skipped) { manifest.tables[table] = { rows: 0, skipped }; log(`- ${table}: skipped (${skipped})`); continue; }
    await writeFile(path.join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    manifest.tables[table] = { rows: rows.length };
    log(`- ${table}: ${rows.length} rows`);
  }

  for (const bucket of BUCKETS) {
    const files = await listBucket(client, bucket);
    await writeFile(path.join(dir, `storage.${bucket}.json`), `${JSON.stringify(files, null, 2)}\n`);
    const bytes = files.reduce((a, f) => a + (f.size || 0), 0);
    manifest.buckets[bucket] = { files: files.length, bytes };
    log(`- storage/${bucket}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
    if (!downloadFiles || !files.length) continue;
    for (const f of files) {
      const { data, error } = await client.storage.from(bucket).download(f.path);
      if (error) { log(`  ! ${bucket}/${f.path}: ${error.message}`); continue; }
      const target = path.join(dir, 'files', bucket, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await data.arrayBuffer()));
    }
    log(`  downloaded ${files.length} files from ${bucket}`);
  }

  manifest.finished_at = new Date().toISOString();
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function pruneOld({ outDir, today, log = console.log }) {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const dates = entries.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name);
  const drop = planPrune(dates, today);
  for (const d of drop) {
    await rm(path.join(outDir, d), { recursive: true, force: true });
    log(`- pruned ${d}`);
  }
  return drop;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('backup.mjs')) {
  const args = process.argv.slice(2);
  const outDir = args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : 'backups';
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }
  const client = createClient(url, key, { auth: { persistSession: false } });
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Backing up ${new URL(url).hostname} to ${path.join(outDir, today)}`);
  const manifest = await runBackup({ client, outDir, today, downloadFiles: args.includes('--files') });
  await pruneOld({ outDir, today });
  const total = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
  console.log(`Done: ${total} rows in ${Object.keys(manifest.tables).length} tables.`);
}
