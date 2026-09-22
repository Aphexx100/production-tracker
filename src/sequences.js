// Shared by the shot tracker and the References tab: one list of sequences.
import { h, modal, toast, errMsg } from './util.js';
import { api } from './state.js';

/** True when the References migration (002_references.sql) has not been run yet. */
export function isMissingTable(e) {
  return ['PGRST205', 'PGRST204', '42P01', '42703'].includes(e?.code) || /schema cache|does not exist|bucket not found/i.test(errMsg(e));
}

export const MIGRATION_HINT = 'The References tables are missing in the database. An admin must run supabase/002_references.sql once in the Supabase SQL Editor.';

/** Ask for a sequence name. Resolves to the trimmed name, or null when cancelled. */
export function askSequenceName() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const name = h('input', { required: true, maxLength: 40, placeholder: 'e.g. SQ030 or Rooftop escape', 'aria-label': 'Sequence name' });
    const m = modal('New sequence', h('form.form', {
      on: { submit: (e) => {
        e.preventDefault();
        const v = name.value.trim();
        if (!v) return;
        finish(v); m.close();
      } },
    }, h('label', 'Name', name),
    h('p.faint', 'The sequence appears in the Seq dropdown of the shot tracker and as a container in References.'),
    h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'Create'))), { onClose: () => finish(null) });
    name.focus();
  });
}

/** Store a sequence so it shows up everywhere, even before any shot uses it. */
export async function saveSequence(code, existing = []) {
  const known = existing.find((s) => s.code === code);
  if (known) return known;
  try {
    const order = Math.max(0, ...existing.map((s) => s.sort_order || 0)) + 1;
    return await api().sequences.upsert({ code, sort_order: order });
  } catch (e) {
    if (isMissingTable(e)) toast(MIGRATION_HINT, 'error', 10000);
    else toast(`Could not save sequence: ${errMsg(e)}`, 'error', 6000);
    return null;
  }
}
