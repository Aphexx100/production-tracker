// Restore a backup made by scripts/backup.mjs.
//
//   node scripts/restore.mjs --dir backups/2026-09-23            (dry run)
//   node scripts/restore.mjs --dir backups/2026-09-23 --yes      (write)
//   node scripts/restore.mjs --dir ... --yes --only shots,todos
//
// Rows are written back by primary key: existing rows are overwritten,
// missing ones are recreated. Nothing is deleted, so rows created after the
// backup survive. Profiles are skipped by default because they belong to
// login accounts, which live in Supabase Auth and are not part of this file.
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TABLES } from './backup.mjs';

const KEYS = { project_settings: 'id', team_members: 'name', admin_emails: 'email', profiles: 'id', sequences: 'code' };
const SKIP_BY_DEFAULT = new Set(['profiles', 'admin_emails']);
const CHUNK = 500;

export function tablesToRestore({ only, withProfiles }) {
  const wanted = only ? only.split(',').map((x) => x.trim()).filter(Boolean) : null;
  return TABLES.filter((t) => (wanted ? wanted.includes(t) : !SKIP_BY_DEFAULT.has(t) || withProfiles));
}

export async function restore({ client, dir, tables, write, log = console.log, read = readFile }) {
  const result = {};
  for (const table of tables) {
    let rows;
    try { rows = JSON.parse(await read(path.join(dir, `${table}.json`), 'utf8')); }
    catch { log(`- ${table}: no file in this backup, skipped`); continue; }
    if (!Array.isArray(rows) || !rows.length) { log(`- ${table}: empty`); result[table] = 0; continue; }
    if (!write) { log(`- ${table}: would write ${rows.length} rows`); result[table] = rows.length; continue; }
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await client.from(table).upsert(chunk, { onConflict: KEYS[table] || 'id' });
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    log(`- ${table}: wrote ${rows.length} rows`);
    result[table] = rows.length;
  }
  return result;
}

if (process.argv[1]?.endsWith('restore.mjs')) {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const dir = arg('--dir');
  const write = args.includes('--yes');
  if (!dir) { console.error('Use --dir backups/YYYY-MM-DD'); process.exit(1); }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.'); process.exit(1); }
  const tables = tablesToRestore({ only: arg('--only'), withProfiles: args.includes('--with-profiles') });
  console.log(`${write ? 'Restoring' : 'Dry run'}: ${dir} -> ${new URL(url).hostname}`);
  console.log(`Tables: ${tables.join(', ')}`);
  const client = createClient(url, key, { auth: { persistSession: false } });
  await restore({ client, dir, tables, write });
  console.log(write ? 'Done.' : 'Nothing was written. Add --yes to restore for real.');
}
