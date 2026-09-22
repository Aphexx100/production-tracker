// Browser-only stand-in for the Supabase backend. Used when the app is opened
// with ?demo or when no Supabase project is configured in a dev build.
// Data lives in this browser's localStorage only — nothing here is secure.
import { lsGet, lsSet } from '../util.js';

const KEY = 'pt-demo-db-v1';
const ME = { id: 'demo-user', email: 'demo@example.com', display_name: 'Demo User', role: 'admin', approved: true, email_confirmed: true };

function seed() {
  const now = new Date().toISOString();
  const day = (off) => {
    const d = new Date(); d.setDate(d.getDate() - off);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const base = { created_by: ME.id, updated_by: ME.id, created_at: now, updated_at: now };
  const shot = (i, o) => ({
    id: crypto.randomUUID(), sort_order: i, status: 'wtg', priority: 'normal', sequence: 'SQ010', scene: '12',
    shot_name: `SQ010_${String(i * 10).padStart(4, '0')}`, description: '', shot_type: '', lens: '', camera: '',
    movement: '', frame_in: 1001, frame_out: null, handles: 8, location: '', int_ext: '', day_night: '',
    shoot_day: null, assignee: null, due_date: null, comments: '', start_date: null, end_date: null, ...base, ...o,
  });
  const shots = [
    shot(1, { status: 'apr', description: '<p>Wide establishing shot of the harbour at dawn. Fog rolls in.</p>', shot_type: 'EWS', lens: '24mm Cooke S4', camera: 'Alexa 35', movement: 'Static', frame_out: 1120, location: 'Harbour', int_ext: 'EXT', day_night: 'DAWN', assignee: 'Sascha', shoot_day: day(2), start_date: day(8), end_date: day(1) }),
    shot(2, { status: 'ip', description: '<p>Mara walks along the pier, <strong>tracking</strong> left to right.</p>', shot_type: 'MS', lens: '50mm Cooke S4', camera: 'Alexa 35', movement: 'Dolly', frame_out: 1210, location: 'Harbour', int_ext: 'EXT', day_night: 'DAWN', assignee: 'Mihai', priority: 'high', shoot_day: day(1), comments: 'Needs sky replacement', start_date: day(3), end_date: day(-8), due_date: day(-9) }),
    shot(3, { status: 'rdy', description: '<p>Close-up on the letter in her hand.</p>', shot_type: 'ECU', lens: '100mm Macro', camera: 'Alexa 35', movement: 'Handheld', frame_out: 1060, location: 'Harbour', int_ext: 'EXT', day_night: 'DAY', assignee: 'Rafael' }),
    shot(4, { sequence: 'SQ020', scene: '14', shot_name: 'SQ020_0010', description: '<p>Interior café, over-the-shoulder.</p>', shot_type: 'OTS', lens: '35mm', frame_out: 1150, location: 'Café', int_ext: 'INT', day_night: 'NIGHT', assignee: 'Miguel', priority: 'urgent' }),
  ];
  return {
    settings: { id: 1, project_name: 'Demo Production', fps: 24, max_upload_mb: 50 },
    team: ['Mihai', 'Miguel', 'Rafael', 'Micael', 'Sascha'].map((name, i) => ({ name, sort_order: i + 1 })),
    profiles: [ME, { id: 'demo-2', email: 'crew@example.com', display_name: 'New Crew', role: 'member', approved: false, created_at: now }],
    dailies: [
      { id: crypto.randomUUID(), day: day(1), title: 'Harbour day 2', content: '<h2>Notes</h2><ul><li><p>Fog machine late, lost 40 min</p></li><li><p>Pier dolly shots all circled</p></li></ul>', ...base },
      { id: crypto.randomUUID(), day: day(2), title: 'Harbour day 1', content: '<p>Dawn shots done. Weather held.</p>', ...base },
    ],
    shots,
    todos: [
      { id: crypto.randomUUID(), shot_id: shots[1].id, person: 'Mihai', body: 'Sky replacement comp', done: false, ...base },
      { id: crypto.randomUUID(), shot_id: shots[1].id, person: 'Rafael', body: 'Roto Mara', done: true, ...base },
      { id: crypto.randomUUID(), shot_id: null, person: 'Sascha', body: 'Book fog machine for Thursday', done: false, ...base },
    ],
    media: {},
    sequences: [
      { code: 'SQ010', title: 'Harbour at dawn', notes: '', sort_order: 1, start_date: day(9), end_date: day(-12), color: null },
      { code: 'SQ020', title: 'Café night', notes: '', sort_order: 2, start_date: day(-5), end_date: day(-26), color: null },
    ],
    milestones: [
      { id: crypto.randomUUID(), title: 'Principal photography starts', kind: 'milestone', date: day(9), sequence: '', shot_id: null, notes: '', done: true, ...base },
      { id: crypto.randomUUID(), title: 'Picture lock', kind: 'deadline', date: day(-35), sequence: '', shot_id: null, notes: 'Editor delivers locked cut', done: false, ...base },
      { id: crypto.randomUUID(), title: 'SQ010 VFX turnover', kind: 'deadline', date: day(-14), sequence: 'SQ010', shot_id: null, notes: '', done: false, ...base },
    ],
    refs: [
      { id: crypto.randomUUID(), sequence: 'SQ010', kind: 'link', title: 'Location scout: harbour', notes: 'Low tide around 6am', url: 'https://example.com/harbour-scout', storage_path: null, thumb_path: null, file_name: null, mime: null, size_bytes: null, ...base },
      { id: crypto.randomUUID(), sequence: 'SQ020', kind: 'link', title: 'Lighting reference', notes: '', url: 'https://example.com/cafe-lighting', storage_path: null, thumb_path: null, file_name: null, mime: null, size_bytes: null, ...base },
    ],
  };
}

// fetch(data:) is blocked by the CSP, so decode by hand.
function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5).split(';')[0] });
}

export function createDemoApi() {
  let db = lsGet(KEY, null) || seed();
  db.sequences ||= [];
  db.refs ||= [];
  db.milestones ||= [];
  const save = () => lsSet(KEY, db);
  const blobUrls = new Map();
  const sessionFiles = new Map();
  save();

  const computed = (name, row) =>
    name === 'shots'
      ? { ...row, duration: row.frame_in != null && row.frame_out != null ? row.frame_out - row.frame_in + 1 : null }
      : { ...row };
  const clone = (x) => structuredClone(x);
  const wait = () => new Promise((r) => setTimeout(r, 30));

  const table = (name, sort) => ({
    list: async () => { await wait(); return clone(db[name].map((r) => computed(name, r)).sort(sort)); },
    get: async (id) => clone(computed(name, db[name].find((r) => r.id === id))),
    create: async (row) => {
      const now = new Date().toISOString();
      const r = { id: crypto.randomUUID(), created_at: now, updated_at: now, created_by: ME.id, updated_by: ME.id, ...defaults(name), ...row };
      db[name].push(r); save();
      return clone(computed(name, r));
    },
    createMany: async (rows) => Promise.all(rows.map((r) => table(name, sort).create(r))),
    update: async (id, patch) => {
      const r = db[name].find((x) => x.id === id);
      if (!r) throw new Error('Row not found');
      const next = { ...r, ...patch };
      if (name === 'shots' && next.frame_in != null && next.frame_out != null && next.frame_out < next.frame_in)
        throw new Error('violates check constraint "frames_order"');
      if (next.start_date && next.end_date && next.end_date < next.start_date)
        throw new Error('violates check constraint "shot_dates"');
      Object.assign(r, patch, { updated_at: new Date().toISOString(), updated_by: ME.id });
      save();
      return clone(computed(name, r));
    },
    remove: async (id) => {
      db[name] = db[name].filter((r) => r.id !== id);
      if (name === 'shots') {
        db.todos = db.todos.filter((t) => t.shot_id !== id);
        db.milestones = db.milestones.filter((m) => m.shot_id !== id);
      }
      save();
    },
  });

  function defaults(name) {
    if (name === 'shots') return { sort_order: 0, status: 'wtg', priority: 'normal', sequence: '', scene: '', shot_name: '', description: '', shot_type: '', lens: '', camera: '', movement: '', frame_in: null, frame_out: null, handles: 0, location: '', int_ext: '', day_night: '', shoot_day: null, assignee: null, due_date: null, comments: '', start_date: null, end_date: null };
    if (name === 'dailies') return { title: '', content: '' };
    if (name === 'todos') return { done: false, shot_id: null };
    if (name === 'milestones') return { kind: 'milestone', sequence: '', shot_id: null, notes: '', done: false };
    if (name === 'refs') return { sequence: '', title: '', notes: '', url: null, storage_path: null, thumb_path: null, file_name: null, mime: null, size_bytes: null };
    return {};
  }

  return {
    mode: 'demo',
    auth: {
      session: async () => ({ user: { id: ME.id, email: ME.email } }),
      onChange: () => () => {},
      signIn: async () => {}, signUp: async () => {}, signOut: async () => { localStorage.removeItem(KEY); location.reload(); },
      resetPassword: async () => {}, setPassword: async () => {},
    },
    profiles: {
      me: async () => clone(db.profiles.find((p) => p.id === ME.id)),
      list: async () => clone(db.profiles),
      update: async (id, patch) => { const p = db.profiles.find((x) => x.id === id); Object.assign(p, patch); save(); return clone(p); },
    },
    settings: {
      get: async () => clone(db.settings),
      update: async (patch) => { Object.assign(db.settings, patch); save(); return clone(db.settings); },
    },
    team: {
      list: async () => clone([...db.team].sort((a, b) => a.sort_order - b.sort_order)),
      add: async (name, sort_order) => {
        if (db.team.some((t) => t.name === name)) throw new Error('Name already exists');
        db.team.push({ name, sort_order }); save(); return { name, sort_order };
      },
      remove: async (name) => {
        db.team = db.team.filter((t) => t.name !== name);
        db.todos = db.todos.filter((t) => t.person !== name);
        db.shots.forEach((s) => { if (s.assignee === name) s.assignee = null; });
        save();
      },
    },
    dailies: table('dailies', (a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at)),
    shots: table('shots', (a, b) => a.sort_order - b.sort_order),
    todos: table('todos', (a, b) => a.created_at.localeCompare(b.created_at)),
    media: {
      async upload(blob) {
        const url = await new Promise((res, rej) => {
          const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
        });
        const path = `demo/${crypto.randomUUID()}`;
        db.media[path] = url; save();
        return path;
      },
      // blob: URLs, like real signed URLs, are not data: URIs (the editor rejects those).
      async urls(paths) {
        const out = {};
        for (const p of paths) {
          if (!blobUrls.has(p) && db.media[p]) blobUrls.set(p, URL.createObjectURL(dataUrlToBlob(db.media[p])));
          out[p] = blobUrls.get(p) || '';
        }
        return out;
      },
    },
    sequences: {
      list: async () => clone([...db.sequences].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))),
      upsert: async (row) => {
        const i = db.sequences.findIndex((x) => x.code === row.code);
        const next = { title: '', notes: '', sort_order: 0, ...(i >= 0 ? db.sequences[i] : {}), ...row };
        if (next.start_date && next.end_date && next.end_date < next.start_date) throw new Error('violates check constraint "sequence_dates"');
        if (i >= 0) db.sequences[i] = next; else db.sequences.push(next);
        save(); return clone(next);
      },
      remove: async (code) => { db.sequences = db.sequences.filter((x) => x.code !== code); save(); },
    },
    milestones: table('milestones', (a, b) => a.date.localeCompare(b.date)),
    refs: table('refs', (a, b) => a.created_at.localeCompare(b.created_at)),
    // Small files persist in localStorage; big ones (movies) only live until reload.
    refFiles: {
      async upload(blob, ext, onProgress) {
        const path = `demo-ref/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;
        for (const f of [0.25, 0.5, 0.75]) { onProgress?.(f); await new Promise((r) => setTimeout(r, 40)); }
        if (blob.size < 1_500_000) {
          db.media[path] = await new Promise((res, rej) => {
            const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
          });
          save();
        } else sessionFiles.set(path, blob);
        onProgress?.(1);
        return path;
      },
      async urls(paths) {
        const out = {};
        for (const p of paths) {
          if (!blobUrls.has(p)) {
            if (sessionFiles.has(p)) blobUrls.set(p, URL.createObjectURL(sessionFiles.get(p)));
            else if (db.media[p]) blobUrls.set(p, URL.createObjectURL(dataUrlToBlob(db.media[p])));
          }
          out[p] = blobUrls.get(p) || '';
        }
        return out;
      },
      async downloadUrl(path) { return (await this.urls([path]))[path]; },
      async remove(paths) { for (const p of paths) { delete db.media[p]; sessionFiles.delete(p); } save(); },
    },
    subscribe: () => () => {},
  };
}
