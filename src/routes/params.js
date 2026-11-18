// Route/query id: a positive decimal integer string. Returns the number, or null.
export function parseIdParam(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Copies only the listed own properties, so clients cannot set columns like source or id.
export function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (Object.hasOwn(obj, key)) out[key] = obj[key];
  return out;
}
