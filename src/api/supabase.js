import { createClient } from '@supabase/supabase-js';

const BUCKET = 'media';
const REF_BUCKET = 'references';
const SIGN_SECONDS = 60 * 60 * 6;

export function createSupabaseApi(url, anonKey) {
  const sb = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const unwrap = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  const table = (name, order) => ({
    list: async () => {
      let q = sb.from(name).select('*');
      for (const [col, asc] of order) q = q.order(col, { ascending: asc });
      return unwrap(await q);
    },
    get: async (id) => unwrap(await sb.from(name).select('*').eq('id', id).single()),
    create: async (row) => unwrap(await sb.from(name).insert(row).select().single()),
    createMany: async (rows) => unwrap(await sb.from(name).insert(rows).select()),
    update: async (id, patch) => unwrap(await sb.from(name).update(patch).eq('id', id).select().single()),
    remove: async (id) => { unwrap(await sb.from(name).delete().eq('id', id)); },
  });

  const signCache = new Map();
  const refSignCache = new Map();

  async function signMany(bucket, cache, paths) {
    const now = Date.now();
    const missing = [...new Set(paths)].filter((p) => {
      const c = cache.get(p);
      return !c || c.exp < now + 60_000;
    });
    if (missing.length) {
      const data = unwrap(await sb.storage.from(bucket).createSignedUrls(missing, SIGN_SECONDS));
      for (const r of data) {
        if (r.signedUrl) cache.set(r.path, { url: r.signedUrl, exp: now + SIGN_SECONDS * 1000 });
      }
    }
    return Object.fromEntries(paths.map((p) => [p, cache.get(p)?.url || '']));
  }

  return {
    mode: 'supabase',

    auth: {
      async session() {
        return unwrap(await sb.auth.getSession()).session;
      },
      onChange(cb) {
        const { data } = sb.auth.onAuthStateChange((event, session) => cb(event, session));
        return () => data.subscription.unsubscribe();
      },
      async signIn(email, password) {
        return unwrap(await sb.auth.signInWithPassword({ email, password }));
      },
      async signUp(email, password, displayName) {
        return unwrap(await sb.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName },
            emailRedirectTo: location.origin + location.pathname,
          },
        }));
      },
      async signOut() {
        await sb.auth.signOut();
      },
      async resetPassword(email) {
        unwrap(await sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname,
        }));
      },
      async setPassword(password) {
        unwrap(await sb.auth.updateUser({ password }));
      },
    },

    profiles: {
      async me() {
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return null;
        const p = unwrap(await sb.from('profiles').select('*').eq('id', user.id).maybeSingle());
        return p && { ...p, email_confirmed: !!user.email_confirmed_at };
      },
      list: async () => unwrap(await sb.from('profiles').select('*').order('created_at')),
      update: async (id, patch) => unwrap(await sb.from('profiles').update(patch).eq('id', id).select().single()),
    },

    settings: {
      get: async () => unwrap(await sb.from('project_settings').select('*').eq('id', 1).single()),
      update: async (patch) => unwrap(await sb.from('project_settings').update(patch).eq('id', 1).select().single()),
    },

    team: {
      list: async () => unwrap(await sb.from('team_members').select('*').order('sort_order').order('name')),
      add: async (name, sort_order) => unwrap(await sb.from('team_members').insert({ name, sort_order }).select().single()),
      remove: async (name) => { unwrap(await sb.from('team_members').delete().eq('name', name)); },
    },

    dailies: table('dailies', [['day', false], ['created_at', false]]),
    shots: table('shots', [['sort_order', true]]),
    todos: table('todos', [['created_at', true]]),

    media: {
      async upload(blob, ext) {
        const d = new Date();
        const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
        unwrap(await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: false }));
        return path;
      },
      /** Resolve many storage paths to short-lived signed URLs. */
      urls: (paths) => signMany(BUCKET, signCache, paths),
    },

    sequences: {
      list: async () => unwrap(await sb.from('sequences').select('*').order('sort_order').order('code')),
      upsert: async (row) => unwrap(await sb.from('sequences').upsert(row, { onConflict: 'code' }).select().single()),
      remove: async (code) => { unwrap(await sb.from('sequences').delete().eq('code', code)); },
    },

    refs: table('refs', [['created_at', true]]),

    refFiles: {
      /**
       * Upload with progress. Plain XHR against the Storage REST API, because
       * supabase-js has no progress events. Returns the storage path.
       */
      async upload(blob, ext, onProgress) {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error('Not signed in');
        const path = `${new Date().getFullYear()}/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${url}/storage/v1/object/${REF_BUCKET}/${path}`);
          xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
          xhr.setRequestHeader('apikey', anonKey);
          xhr.setRequestHeader('x-upsert', 'false');
          xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
          xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
            let msg = `Upload failed (${xhr.status})`;
            try { const j = JSON.parse(xhr.responseText); msg = j.message || j.error || msg; } catch { /* not JSON */ }
            if (xhr.status === 413 || /maximum allowed size|too large/i.test(msg)) msg = 'File is larger than the project upload limit (Supabase > Storage > Settings)';
            reject(new Error(msg));
          };
          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.send(blob);
        });
        return path;
      },
      urls: (paths) => signMany(REF_BUCKET, refSignCache, paths),
      async downloadUrl(path, fileName) {
        const { data, error } = await sb.storage.from(REF_BUCKET).createSignedUrl(path, 300, { download: fileName || true });
        if (error) throw error;
        return data.signedUrl;
      },
      async remove(paths) {
        const list = paths.filter(Boolean);
        if (list.length) unwrap(await sb.storage.from(REF_BUCKET).remove(list));
      },
    },

    /** Calls cb(eventType, newRow, oldRow) for changes made by anyone. */
    subscribe(tableName, cb) {
      const ch = sb
        .channel(`rt-${tableName}-${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: tableName },
          (p) => cb(p.eventType, p.new, p.old))
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}
