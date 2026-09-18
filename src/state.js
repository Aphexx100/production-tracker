// Shared app state and a tiny event bus.
const listeners = new Map();

export const state = {
  api: null,
  me: null,
  settings: { project_name: '', fps: 24 },
  team: [],
  profiles: [],
};

export const api = () => state.api;

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) fn(payload);
}

export const isAdmin = () => state.me?.role === 'admin';

export function profileName(id) {
  if (!id) return '';
  const p = state.profiles.find((x) => x.id === id);
  return p ? p.display_name || p.email : 'unknown';
}
