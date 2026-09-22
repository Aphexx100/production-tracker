import './style.css';
import { h, toast, errMsg } from './util.js';
import { icon } from './icons.js';
import { state, api, on, emit as emit_, isAdmin } from './state.js';
import { renderAuth, renderPending, renderSetup } from './auth.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
let booted = null; // user id the app is running for
let recovering = false; // password-reset link was opened

async function init() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (params.has('demo')) {
    const { createDemoApi } = await import('./api/demo.js');
    state.api = createDemoApi();
  } else if (url && key) {
    const { createSupabaseApi } = await import('./api/supabase.js');
    state.api = createSupabaseApi(url, key);
  } else {
    renderSetup(root);
    return;
  }

  api().auth.onChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; booted = null; renderAuth(root, 'recover'); return; }
    if (recovering) return;
    if (event === 'SIGNED_OUT') { booted = null; location.hash = ''; renderAuth(root, 'signin'); return; }
    if (event === 'SIGNED_IN' && session?.user && booted !== session.user.id) start();
  });

  const session = await api().auth.session().catch(() => null);
  if (recovering || /type=recovery/.test(location.hash)) return; // PASSWORD_RECOVERY handler takes over
  if (session) start(); else renderAuth(root, 'signin');
}

async function start() {
  try {
    state.me = await api().profiles.me();
  } catch (e) {
    toast(`Could not load your profile: ${errMsg(e)}`, 'error', 8000);
    renderAuth(root, 'signin');
    return;
  }
  if (!state.me) { renderAuth(root, 'signin'); return; }
  if (!state.me.approved || !state.me.email_confirmed) {
    booted = null;
    renderPending(root, start);
    return;
  }
  if (booted === state.me.id) return;
  booted = state.me.id;
  try {
    [state.settings, state.team, state.profiles] = await Promise.all([
      api().settings.get(), api().team.list(), api().profiles.list(),
    ]);
  } catch (e) {
    toast(`Could not load project: ${errMsg(e)}`, 'error', 8000);
  }
  renderApp();
}

function renderApp() {
  const tabs = [
    { id: 'dailies', label: 'Daily summaries', short: 'Dailies', icon: 'note', load: () => import('./dailies.js').then((m) => m.mountDailies) },
    { id: 'shots', label: 'Shot tracker', short: 'Shots', icon: 'film', load: () => import('./shots.js').then((m) => m.mountShots) },
    { id: 'references', label: 'References', short: 'Refs', icon: 'folder', load: () => import('./references.js').then((m) => m.mountReferences) },
    { id: 'timeline', label: 'Timeline', short: 'Time', icon: 'calendar', load: () => import('./timeline.js').then((m) => m.mountTimeline) },
  ];
  const panes = {};
  const mounted = {};
  let active = null;

  const title = h('span.project-name');
  const tabBar = h('nav.tabs', { role: 'tablist', 'aria-label': 'Sections' });
  const adminBtn = h('button.btn.ghost', { type: 'button', hidden: !isAdmin(), title: 'Admin', 'aria-label': 'Admin' }, icon('settings', 16), h('span.long', 'Admin'));
  adminBtn.addEventListener('click', () => import('./admin.js').then((m) => m.openAdmin()));
  const userBtn = h('button.btn.ghost', { type: 'button', title: 'Your account', 'aria-label': 'Your account' }, icon('user', 16), h('span.user-name'));
  userBtn.addEventListener('click', () => import('./admin.js').then((m) => m.openAccount()));
  const demoBadge = api().mode === 'demo' ? h('span.demo-badge', { title: 'Data is stored only in this browser' }, 'DEMO · local only') : null;

  const header = h('header.app-head',
    h('div.brand', h('span.brand-mark', '▶'), title), demoBadge, tabBar, h('div.spacer'), adminBtn, userBtn);
  const mainEl = h('main.app-main');
  root.replaceChildren(h('div.app', header, mainEl));

  const paint = () => {
    title.textContent = state.settings.project_name || 'Production Tracker';
    document.title = `${state.settings.project_name || 'Production'} · Tracker`;
    userBtn.querySelector('.user-name').textContent = state.me.display_name || state.me.email;
    const pending = state.profiles.filter((p) => !p.approved).length;
    adminBtn.querySelector('.badge')?.remove();
    if (pending && isAdmin()) adminBtn.append(h('span.badge', { title: `${pending} waiting for approval` }, String(pending)));
  };
  paint();
  on('settings-changed', paint);
  on('me-changed', paint);

  for (const t of tabs) {
    const btn = h('button.tab', { type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-controls': `pane-${t.id}` }, icon(t.icon, 16), h('span.long', t.label), h('span.short', t.short));
    btn.addEventListener('click', () => show(t.id));
    tabBar.append(btn);
    panes[t.id] = h(`section.pane#pane-${t.id}`, { role: 'tabpanel', 'aria-labelledby': `tab-${t.id}`, hidden: true });
    mainEl.append(panes[t.id]);
  }

  async function show(id) {
    if (active === id) return;
    if (active) await mounted[active]?.leave?.();
    active = id;
    for (const t of tabs) {
      const on_ = t.id === id;
      panes[t.id].hidden = !on_;
      const b = tabBar.querySelector(`#tab-${t.id}`);
      b.classList.toggle('on', on_);
      b.setAttribute('aria-selected', String(on_));
    }
    if (!mounted[id]) {
      const mount = await tabs.find((t) => t.id === id).load();
      mounted[id] = mount(panes[id]);
    }
    mounted[id].enter?.();
  }

  // Cross-links, e.g. a sequence in the shot tracker <-> its references.
  on('navigate', async ({ tab, sequence, shot }) => {
    await show(tab);
    if (shot) mounted[tab]?.revealShot?.(shot);
    else if (sequence != null) mounted[tab]?.reveal?.(sequence);
  });

  // Links like #shots or #references/SQ010 switch tabs without a reload.
  window.addEventListener('hashchange', () => {
    const t = tabs.find((x) => location.hash.startsWith(`#${x.id}`));
    if (!t) return;
    const seq = t.id === 'references' && location.hash.match(/^#references\/(.+)$/);
    if (seq) emit_('navigate', { tab: t.id, sequence: decodeURIComponent(seq[1]) }); else show(t.id);
  });

  const start_ = tabs.find((t) => location.hash.startsWith(`#${t.id}`))?.id || 'dailies';
  show(start_);
}

init().catch((e) => {
  root.replaceChildren(h('main.auth', h('div.auth-card', h('h1', 'Something went wrong'), h('p', errMsg(e)))));
});
