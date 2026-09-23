import { h, modal, toast, errMsg, fmtTime, confirmDialog, todayISO, download } from './util.js';
import { api, state, emit, isAdmin } from './state.js';
import { icon } from './icons.js';
import { passwordProblem } from './auth.js';

export function openAccount() {
  const name = h('input', { value: state.me.display_name, maxLength: 80, 'aria-label': 'Display name' });
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat new password' });
  const m = modal('Your account', [
    h('p.faint', state.me.email, ' · ', state.me.role),
    h('form.form', { on: { submit: async (e) => {
      e.preventDefault();
      try {
        const p = await api().profiles.update(state.me.id, { display_name: name.value.trim() || state.me.email });
        Object.assign(state.me, p);
        const i = state.profiles.findIndex((x) => x.id === p.id); if (i >= 0) state.profiles[i] = p;
        emit('me-changed');
        toast('Name saved');
      } catch (err) { toast(errMsg(err), 'error'); }
    } } }, h('label', 'Display name', name), h('button.btn', { type: 'submit' }, 'Save name')),
    h('form.form', { on: { submit: async (e) => {
      e.preventDefault();
      const bad = passwordProblem(pw1.value, state.me.email);
      if (bad) { toast(bad, 'error'); return; }
      if (pw1.value !== pw2.value) { toast('Passwords do not match', 'error'); return; }
      try { await api().auth.setPassword(pw1.value); pw1.value = pw2.value = ''; toast('Password changed'); }
      catch (err) { toast(errMsg(err), 'error'); }
    } } }, h('h3', 'Change password'), h('label', 'New password', pw1), h('label', 'Repeat', pw2), h('button.btn', { type: 'submit' }, 'Change password')),
    h('div.row.end', h('button.btn.danger', { type: 'button', on: { click: () => { m.close(); api().auth.signOut(); } } }, 'Sign out')),
  ]);
}

export async function openAdmin() {
  if (!isAdmin()) return;
  const usersBox = h('div');
  const teamBox = h('div');
  const projName = h('input', { value: state.settings.project_name, maxLength: 120, 'aria-label': 'Project name' });
  const fps = h('input', { type: 'number', min: 1, max: 240, step: 0.001, value: state.settings.fps, 'aria-label': 'Frame rate' });
  // max_upload_mb exists once supabase/003_upload_limit.sql has been run.
  const hasLimit = state.settings.max_upload_mb !== undefined;
  const maxUpload = h('input', {
    type: 'number', min: 1, max: 500000, step: 1, value: state.settings.max_upload_mb ?? 50, disabled: !hasLimit,
    'aria-label': 'Upload limit in MB',
    title: hasLimit ? 'Keep equal to Supabase › Storage › Settings › Upload file size limit (50 MB on the free plan).' : 'Run supabase/003_upload_limit.sql in the Supabase SQL Editor to enable this setting.',
  });

  modal('Admin', [
    h('section', h('h3', 'Users'), h('p.faint', 'New accounts cannot see anything until you approve them. Only approve people you know.'), usersBox),
    h('section', h('h3', 'Project'),
      h('form.form.inline', { on: { submit: async (e) => {
        e.preventDefault();
        try {
          const patch = { project_name: projName.value.trim() || 'Untitled Production', fps: Number(fps.value) || 24 };
          if (hasLimit) patch.max_upload_mb = Math.max(1, Math.round(Number(maxUpload.value) || 50));
          state.settings = await api().settings.update(patch);
          emit('settings-changed');
          toast('Project settings saved');
        } catch (err) { toast(errMsg(err), 'error'); }
      } } }, h('label', 'Name', projName), h('label', 'FPS', fps), h('label', 'Upload limit (MB)', maxUpload), h('button.btn', { type: 'submit' }, 'Save')),
      h('p.faint', hasLimit
        ? 'Upload limit: files larger than this are refused before uploading. Keep it equal to Supabase › Storage › Settings (50 MB on the free plan).'
        : 'Upload limit setting: run supabase/003_upload_limit.sql in the Supabase SQL Editor to enable it. Until then the app uses 50 MB.')),
    h('section', h('h3', 'Team (to-do lists)'), teamBox),
    h('section', h('h3', 'Backup'),
      h('p.faint', 'A nightly backup of the whole project runs on GitHub (see the README). Use this button for an extra copy right now: it downloads everything you can see as one JSON file. Uploaded files stay in Supabase storage.'),
      h('div.row', h('button.btn', { type: 'button', on: { click: (e) => downloadBackup(e.currentTarget) } }, icon('download', 15), 'Download backup (JSON)'))),
  ], { wide: true });

  async function renderUsers() {
    try { state.profiles = await api().profiles.list(); emit('me-changed'); } catch (e) { usersBox.replaceChildren(h('p', errMsg(e))); return; }
    const pending = state.profiles.filter((p) => !p.approved);
    usersBox.replaceChildren(h('table.simple',
      h('thead', h('tr', ['Name', 'Email', 'Registered', 'Role', 'Access', ''].map((x) => h('th', x)))),
      h('tbody', [...pending, ...state.profiles.filter((p) => p.approved)].map((p) => {
        const self = p.id === state.me.id;
        const role = h('select', { disabled: self, 'aria-label': `Role for ${p.email}` }, h('option', { value: 'member' }, 'member'), h('option', { value: 'admin' }, 'admin'));
        role.value = p.role;
        role.addEventListener('change', () => update(p, { role: role.value }));
        const access = p.approved
          ? h('button.btn.small', { type: 'button', disabled: self, on: { click: async () => {
            if (await confirmDialog(`Revoke access for ${p.email}? They will no longer see any project data.`, 'Revoke')) update(p, { approved: false });
          } } }, 'Revoke')
          : h('button.btn.small.primary', { type: 'button', on: { click: () => update(p, { approved: true }) } }, 'Approve');
        return h(`tr${p.approved ? '' : '.pending'}`,
          h('td', p.display_name), h('td', p.email), h('td', fmtTime(p.created_at)), h('td', role),
          h('td', p.approved ? 'approved' : h('strong', 'pending')), h('td', access));
      }))));
  }
  async function update(p, patch) {
    try { await api().profiles.update(p.id, patch); toast('Saved'); }
    catch (e) { toast(errMsg(e), 'error'); }
    renderUsers();
  }

  function renderTeam() {
    const input = h('input', { placeholder: 'Name', maxLength: 40, 'aria-label': 'New team member' });
    teamBox.replaceChildren(
      h('ul.team-list', state.team.map((m) => h('li', m.name,
        h('button.btn.small', { type: 'button', on: { click: async () => {
          if (!(await confirmDialog(`Remove ${m.name}? Their to-do list is deleted too.`, 'Remove'))) return;
          try { await api().team.remove(m.name); state.team = await api().team.list(); emit('team-changed'); renderTeam(); }
          catch (e) { toast(errMsg(e), 'error'); }
        } } }, 'Remove')))),
      h('form.form.inline', { on: { submit: async (e) => {
        e.preventDefault();
        const n = input.value.trim();
        if (!n) return;
        try {
          await api().team.add(n, Math.max(0, ...state.team.map((t) => t.sort_order)) + 1);
          state.team = await api().team.list(); emit('team-changed'); renderTeam();
        } catch (err) { toast(errMsg(err), 'error'); }
      } } }, input, h('button.btn', { type: 'submit' }, 'Add person')));
  }

  renderUsers();
  renderTeam();
}

/** Manual backup from the browser, with the signed-in user's own access. */
async function downloadBackup(button) {
  const label = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Collecting…';
  const empty = () => [];
  try {
    const [settings, team, profiles, sequences, shots, dailies, milestones, todos, refs] = await Promise.all([
      api().settings.get().catch(() => null),
      api().team.list().catch(empty),
      api().profiles.list().catch(empty),
      api().sequences.list().catch(empty),
      api().shots.list().catch(empty),
      api().dailies.list().catch(empty),
      api().milestones.list().catch(empty),
      api().todos.list().catch(empty),
      api().refs.list().catch(empty),
    ]);
    const data = {
      exported_at: new Date().toISOString(),
      exported_by: state.me?.email || '',
      project: settings?.project_name || '',
      note: 'Files in storage are not included; their rows list the paths.',
      tables: { project_settings: settings ? [settings] : [], team_members: team, profiles, sequences, shots, dailies, milestones, todos, refs },
    };
    const name = (data.project || 'production').replace(/[^\w-]+/g, '_');
    download(`${name}_backup_${todayISO()}.json`, JSON.stringify(data, null, 2), 'application/json');
    const rows = Object.values(data.tables).reduce((a, t) => a + t.length, 0);
    toast(`Backup downloaded: ${rows} rows`);
  } catch (e) {
    toast(`Backup failed: ${errMsg(e)}`, 'error', 8000);
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}
