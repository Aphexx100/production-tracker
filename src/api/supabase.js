import { createClient } from '@supabase/supabase-js';

const BUCKET = 'media';
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
      async urls(paths) {
        const now = Date.now();
        const missing = [...new Set(paths)].filter((p) => {
          const c = signCache.get(p);
          return !c || c.exp < now + 60_000;
        });
        if (missing.length) {
          const data = unwrap(await sb.storage.from(BUCKET).createSignedUrls(missing, SIGN_SECONDS));
          for (const r of data) {
            if (r.signedUrl) signCache.set(r.path, { url: r.signedUrl, exp: now + SIGN_SECONDS * 1000 });
          }
        }
        return Object.fromEntries(paths.map((p) => [p, signCache.get(p)?.url || '']));
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
