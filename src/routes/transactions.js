import { Router } from 'express';
import { TYPES, ValidationError, isValidDate, validateTransaction } from '../validate.js';
import { parseIdParam, pick } from './params.js';

const EDITABLE_FIELDS = ['type', 'amount', 'amount_minor', 'occurred_on', 'category_id', 'description'];

const SELECT_ROW = `
  SELECT t.id, t.type, t.amount_minor, t.currency, t.occurred_on, t.category_id,
         c.name AS category_name, c.color AS category_color,
         t.description, t.source, t.created_at, t.updated_at
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
`;

export function transactionsRouter(db) {
  const router = Router();

  const getRow = db.prepare(`${SELECT_ROW} WHERE t.id = ?`);
  const getCategory = db.prepare('SELECT id, type, archived_at FROM categories WHERE id = ?');
  const insertRow = db.prepare(`
    INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description)
    VALUES (@type, @amount_minor, @occurred_on, @category_id, @description)
  `);
  const updateRow = db.prepare(`
    UPDATE transactions
    SET type = @type, amount_minor = @amount_minor, occurred_on = @occurred_on,
        category_id = @category_id, description = @description,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id
  `);
  const deleteRow = db.prepare('DELETE FROM transactions WHERE id = ?');

  // previousCategoryId: an archived category may stay on a transaction that already had it,
  // but cannot be newly assigned.
  function assertCategory(value, previousCategoryId = null) {
    if (value.category_id === null) return;
    const category = getCategory.get(value.category_id);
    if (!category) {
      throw new ValidationError({ category_id: 'Категорію не знайдено' });
    }
    if (category.type !== value.type) {
      throw new ValidationError({
        category_id: value.type === 'income' ? 'Це категорія витрат' : 'Це категорія доходів',
      });
    }
    if (category.archived_at && category.id !== previousCategoryId) {
      throw new ValidationError({ category_id: 'Категорія в архіві' });
    }
  }

  router.get('/', (req, res) => {
    const { where, params } = buildFilter(req.query);
    const items = db.prepare(`${SELECT_ROW} ${where} ORDER BY t.occurred_on DESC, t.id DESC`).all(params);
    const totals = db.prepare(`
      SELECT coalesce(sum(CASE WHEN t.type = 'income' THEN t.amount_minor END), 0) AS income,
             coalesce(sum(CASE WHEN t.type = 'expense' THEN t.amount_minor END), 0) AS expense
      FROM transactions t ${where}
    `).get(params);
    res.json({ items, totals: { ...totals, balance: totals.income - totals.expense } });
  });

  router.get('/:id', (req, res) => {
    res.json(findOr404(getRow, req.params.id));
  });

  router.post('/', (req, res) => {
    const value = validateTransaction(pick(req.body ?? {}, EDITABLE_FIELDS));
    assertCategory(value);
    const { lastInsertRowid } = insertRow.run(value);
    res.status(201).json(getRow.get(lastInsertRowid));
  });

  router.patch('/:id', (req, res) => {
    const existing = findOr404(getRow, req.params.id);
    const patch = pick(req.body ?? {}, EDITABLE_FIELDS);
    const merged = { ...pick(existing, EDITABLE_FIELDS), ...patch };
    // A new human-entered amount wins over the stored minor units.
    if ('amount' in patch && !('amount_minor' in patch)) delete merged.amount_minor;

    const value = validateTransaction(merged);
    assertCategory(value, existing.category_id);
    updateRow.run({ ...value, id: existing.id });
    res.json(getRow.get(existing.id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseIdParam(req.params.id);
    if (!id || deleteRow.run(id).changes === 0) {
      return res.status(404).json({ error: 'Операцію не знайдено' });
    }
    res.status(204).end();
  });

  return router;
}

function findOr404(stmt, rawId) {
  const id = parseIdParam(rawId);
  const row = id && stmt.get(id);
  if (!row) throw Object.assign(new Error('Операцію не знайдено'), { status: 404 });
  return row;
}

// Query: from, to (YYYY-MM-DD, inclusive), type, category_id (an id or "none" for uncategorized).
function buildFilter(query) {
  const errors = {};
  const clauses = [];
  const params = {};

  for (const key of ['from', 'to']) {
    if (query[key] === undefined || query[key] === '') continue;
    if (!isValidDate(query[key])) errors[key] = 'Дата має бути у форматі РРРР-ММ-ДД';
    else {
      clauses.push(`t.occurred_on ${key === 'from' ? '>=' : '<='} @${key}`);
      params[key] = query[key];
    }
  }

  if (query.type !== undefined && query.type !== '') {
    if (!TYPES.includes(query.type)) errors.type = 'Тип має бути income або expense';
    else {
      clauses.push('t.type = @type');
      params.type = query.type;
    }
  }

  if (query.category_id !== undefined && query.category_id !== '') {
    if (query.category_id === 'none') clauses.push('t.category_id IS NULL');
    else {
      const id = parseIdParam(query.category_id);
      if (!id) errors.category_id = 'Некоректна категорія';
      else {
        clauses.push('t.category_id = @category_id');
        params.category_id = id;
      }
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
