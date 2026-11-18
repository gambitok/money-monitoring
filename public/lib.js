// Shared helpers. All user text goes into the DOM via text nodes (see h()), never innerHTML.

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    // setProperty, not Object.assign: custom properties (--chip-color) are ignored by assignment.
    else if (key === 'style') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ---------- API ----------

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.fields = body?.fields ?? null;
  }
}

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- preferences (per browser, optional) ----------

export function readPref(key, fallback) {
  try { return localStorage.getItem(`mm.${key}`) ?? fallback; } catch { return fallback; }
}

export function writePref(key, value) {
  try { localStorage.setItem(`mm.${key}`, value); } catch { /* storage unavailable */ }
}

// ---------- dates: calendar days as 'YYYY-MM-DD', math in UTC so DST never shifts a day ----------

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isoToUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(iso, n) {
  const d = isoToUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function startOfWeek(iso) {
  const day = isoToUtc(iso).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((day + 6) % 7)); // weeks start on Monday
}

export const dayFmt = new Intl.DateTimeFormat('uk-UA', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const shortDateFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const yearFmt = new Intl.DateTimeFormat('uk-UA', { year: 'numeric', timeZone: 'UTC' });

// ---------- money ----------

const moneyFmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(minor) {
  return `${moneyFmt.format(minor / 100)} ₴`;
}

export function formatSigned(type, minor) {
  return `${type === 'income' ? '+' : '−'}${formatMoney(minor)}`;
}

// For putting a stored amount back into the input: "1234,50", no grouping.
export function minorToInput(minor) {
  const s = String(minor).padStart(3, '0');
  const cents = s.slice(-2);
  return cents === '00' ? s.slice(0, -2) : `${s.slice(0, -2)},${cents}`;
}

// ---------- words ----------

const pluralRules = new Intl.PluralRules('uk');

// plural(5, ['операція', 'операції', 'операцій']) → '5 операцій'
export function plural(n, [one, few, many]) {
  const form = pluralRules.select(n);
  return `${n} ${form === 'one' ? one : form === 'few' ? few : many}`;
}

export const TYPE_LABELS = { expense: 'Витрати', income: 'Доходи' };
