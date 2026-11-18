// Single source of truth for categories on the page. Views subscribe and re-render on change.
import { api } from './lib.js';

export const PALETTE = [
  '#e11d48', '#2563eb', '#16a34a', '#ca8a04', '#9333ea',
  '#0891b2', '#ea580c', '#db2777', '#4f46e5', '#65a30d',
];

let items = [];
const listeners = new Set();

export function all() {
  return items;
}

export function byId(id) {
  return items.find((c) => c.id === id) ?? null;
}

export function active(type) {
  return items.filter((c) => c.type === type && !c.archived_at);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function load() {
  items = (await api('GET', '/categories?include_archived=1')).items;
  for (const fn of listeners) fn(items);
  return items;
}

// First palette color not used by an active category of this type, so new ones look distinct.
export function nextColor(type) {
  const used = new Set(active(type).map((c) => c.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[active(type).length % PALETTE.length];
}

export async function create(data) {
  const created = await api('POST', '/categories', data);
  await load();
  return created;
}

export async function update(id, patch) {
  const updated = await api('PATCH', `/categories/${id}`, patch);
  await load();
  return updated;
}

// Resolves to { deleted, archived }: a category with transactions is archived instead.
export async function remove(id) {
  const result = await api('DELETE', `/categories/${id}`);
  await load();
  return result;
}
