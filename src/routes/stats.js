import { Router } from 'express';
import { TYPES, ValidationError, isValidDate } from '../validate.js';
import { parseIdParam } from './params.js';
import { createUsdRate } from '../usd.js';

export const MAX_ITEMS = 1000;
const TOP_DESCRIPTIONS = 30;
const TOP_WORDS = 40;

// Words too common to say anything about a purchase.
const STOP_WORDS = new Set(['в', 'у', 'і', 'й', 'та', 'на', 'з', 'за', 'до', 'для', 'по', 'мене', 'and', 'the', 'v']);

const collator = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });
const lower = (s) => s.toLocaleLowerCase('uk');

function normalizeDescription(d) {
  return lower(d).replace(/\s+/g, ' ').trim();
}

// Splits a description into words: letters/digits (any script) plus apostrophes inside words.
function wordsOf(d) {
  return lower(d).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? [];
}

// Search: comma-separated alternatives (any may match); words inside one alternative must all
// appear. "steam, lifecell" → steam OR lifecell; "кава атб" → кава AND атб. Case-insensitive,
// Cyrillic included (done in JS: SQLite LIKE folds ASCII only).
export function parseQuery(q) {
  if (typeof q !== 'string') return [];
  return q.split(',').map((alt) => lower(alt).split(/\s+/).filter(Boolean)).filter((words) => words.length > 0);
}

export function matchesQuery(description, query) {
  if (query.length === 0) return true;
  if (!description) return false;
  const text = lower(description);
  return query.some((words) => words.every((w) => text.includes(w)));
}

// Purchase statistics for a period with category and description filters.
// Query: from, to (YYYY-MM-DD, optional, inclusive), type (expense | income, default expense),
// category_ids (comma-separated ids and/or "none"), q (description search, see parseQuery).
export function statsRouter(db) {
  const router = Router();
  const usdRate = createUsdRate(db);

  router.get('/', (req, res) => {
    const errors = {};
    const params = {};
    const clauses = [];

    for (const key of ['from', 'to']) {
      const value = req.query[key];
      if (value === undefined || value === '') continue;
      if (!isValidDate(value)) errors[key] = 'Дата має бути у форматі РРРР-ММ-ДД';
      else {
        clauses.push(`t.occurred_on ${key === 'from' ? '>=' : '<='} @${key}`);
        params[key] = value;
      }
    }

    const type = req.query.type ?? 'expense';
    if (!TYPES.includes(type)) errors.type = 'Тип має бути income або expense';
    else {
      clauses.push('t.type = @type');
      params.type = type;
    }

    let categoryIds = null;
    let includeNone = false;
    if (typeof req.query.category_ids === 'string' && req.query.category_ids !== '') {
      categoryIds = [];
      for (const raw of req.query.category_ids.split(',')) {
        if (raw === 'none') includeNone = true;
        else {
          const id = parseIdParam(raw);
          if (id) categoryIds.push(id);
          else errors.category_ids = 'Некоректна категорія';
        }
      }
    }
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);

    if (categoryIds) {
      const parts = [];
      if (categoryIds.length) parts.push(`t.category_id IN (${categoryIds.join(',')})`); // validated integers
      if (includeNone) parts.push('t.category_id IS NULL');
      clauses.push(`(${parts.join(' OR ')})`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT t.id, t.type, t.amount_minor, t.occurred_on, t.category_id, t.description,
             c.name AS category_name, c.color AS category_color
      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      ${where}
      ORDER BY t.occurred_on DESC, t.id DESC
    `).all(params);

    const query = parseQuery(req.query.q);
    const items = rows.filter((t) => matchesQuery(t.description, query));

    res.json({
      totals: totalsOf(items),
      byCategory: byCategory(items),
      byMonth: byMonth(items),
      topDescriptions: topDescriptions(items),
      words: topWords(items, query),
      items: items.slice(0, MAX_ITEMS),
      truncated: items.length > MAX_ITEMS,
      usd: usdRate({ from: params.from ?? null, to: params.to ?? null }), // { rate, source } | null
    });
  });

  return router;
}

function totalsOf(items) {
  const sum = items.reduce((s, t) => s + t.amount_minor, 0);
  const months = new Set(items.map((t) => t.occurred_on.slice(0, 7)));
  return {
    sum,
    count: items.length,
    avg: items.length ? Math.round(sum / items.length) : 0,
    max: items.reduce((m, t) => Math.max(m, t.amount_minor), 0),
    months: months.size, // months that have at least one matching transaction
    first: items.at(-1)?.occurred_on ?? null,
    last: items[0]?.occurred_on ?? null,
  };
}

function byCategory(items) {
  const map = new Map();
  for (const t of items) {
    const key = t.category_id ?? 'none';
    const row = map.get(key) ?? { category_id: t.category_id, name: t.category_name, color: t.category_color, sum: 0, count: 0 };
    row.sum += t.amount_minor;
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.sum - a.sum);
}

function byMonth(items) {
  const map = new Map();
  for (const t of items) {
    const m = t.occurred_on.slice(0, 7);
    const row = map.get(m) ?? { month: m, sum: 0, count: 0 };
    row.sum += t.amount_minor;
    row.count += 1;
    map.set(m, row);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Identical descriptions grouped (case/space-insensitive): "steam" ×20, "lifecell" ×12...
// count = distinct days: the legacy import splits one day into several category amounts that
// share the day's description, which must not count as several purchases.
function topDescriptions(items) {
  const map = new Map();
  for (const t of items) {
    if (!t.description) continue;
    const key = normalizeDescription(t.description);
    const row = map.get(key) ?? { description: t.description, sum: 0, days: new Set(), last: t.occurred_on };
    row.sum += t.amount_minor;
    row.days.add(t.occurred_on);
    if (t.occurred_on > row.last) row.last = t.occurred_on;
    map.set(key, row);
  }
  return [...map.values()]
    .map(({ days, ...r }) => ({ ...r, count: days.size, avg: Math.round(r.sum / days.size) }))
    .sort((a, b) => b.count - a.count || b.sum - a.sum || collator.compare(a.description, b.description))
    .slice(0, TOP_DESCRIPTIONS);
}

// Words across descriptions: on how many days each appears and the total of those transactions.
// A transaction with several words counts toward each of them, so sums overlap by design.
function topWords(items, query) {
  const searched = new Set(query.flat());
  const map = new Map();
  for (const t of items) {
    if (!t.description) continue;
    for (const word of new Set(wordsOf(t.description))) {
      if (word.length < 3 || STOP_WORDS.has(word) || /^\d+$/.test(word) || searched.has(word)) continue;
      const row = map.get(word) ?? { word, sum: 0, days: new Set() };
      row.sum += t.amount_minor;
      row.days.add(t.occurred_on);
      map.set(word, row);
    }
  }
  return [...map.values()].map(({ days, ...r }) => ({ ...r, count: days.size })).sort((a, b) => b.count - a.count || b.sum - a.sum).slice(0, TOP_WORDS);
}
