import { Router } from 'express';
import { TYPES, ValidationError, validateCategory } from '../validate.js';
import { parseIdParam, pick } from './params.js';

const collator = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });

const EDITABLE_FIELDS = ['name', 'type', 'color'];

const SELECT_ROW = `
  SELECT c.id, c.name, c.type, c.color, c.archived_at, c.created_at,
         (SELECT count(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count
  FROM categories c
`;

// SQLite sorts by code point (Є, І, Ї before А; Ґ after Я), so sort with the Ukrainian collation.
function sortCategories(items) {
  return items.sort((a, b) => a.type.localeCompare(b.type) || collator.compare(a.name, b.name));
}

export function categoriesRouter(db) {
  const router = Router();

  const getRow = db.prepare(`${SELECT_ROW} WHERE c.id = ?`);
  const insertRow = db.prepare('INSERT INTO categories (name, type, color) VALUES (@name, @type, @color)');
  const updateRow = db.prepare(`
    UPDATE categories SET name = @name, type = @type, color = @color, archived_at = @archived_at WHERE id = @id
  `);
  const deleteRow = db.prepare('DELETE FROM categories WHERE id = ?');
  const archiveRow = db.prepare(`
    UPDATE categories SET archived_at = coalesce(archived_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?
  `);

  function findOr404(rawId) {
    const id = parseIdParam(rawId);
    const row = id && getRow.get(id);
    if (!row) throw Object.assign(new Error('Категорію не знайдено'), { status: 404 });
    return row;
  }

  const sameType = db.prepare('SELECT id, name, archived_at FROM categories WHERE type = ? AND id IS NOT ?');

  // The UNIQUE(name, type) index is case-sensitive, and SQLite NOCASE folds ASCII only,
  // so "їжа" next to "Їжа" is caught here in JS.
  function assertUniqueName(value, exceptId = null) {
    const lower = value.name.toLocaleLowerCase('uk');
    const clash = sameType.all(value.type, exceptId)
      .find((c) => c.name.toLocaleLowerCase('uk') === lower);
    if (clash) {
      const err = new ValidationError({
        name: clash.archived_at ? 'Категорія з такою назвою є в архіві' : 'Категорія з такою назвою вже є',
      });
      err.status = 409;
      err.details = { conflict_id: clash.id };
      throw err;
    }
  }

  // Query: type (income|expense), include_archived (1 to include archived categories).
  router.get('/', (req, res) => {
    const clauses = [];
    const params = {};

    if (req.query.type !== undefined && req.query.type !== '') {
      if (!TYPES.includes(req.query.type)) {
        throw new ValidationError({ type: 'Тип має бути income або expense' });
      }
      clauses.push('c.type = @type');
      params.type = req.query.type;
    }
    if (req.query.include_archived !== '1') clauses.push('c.archived_at IS NULL');

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json({ items: sortCategories(db.prepare(`${SELECT_ROW} ${where}`).all(params)) });
  });

  router.get('/:id', (req, res) => {
    res.json(findOr404(req.params.id));
  });

  router.post('/', (req, res) => {
    const value = validateCategory(pick(req.body ?? {}, EDITABLE_FIELDS));
    assertUniqueName(value);
    const { lastInsertRowid } = insertRow.run(value);
    res.status(201).json(getRow.get(lastInsertRowid));
  });

  // Body: any of name, type, color, plus archived (boolean) to archive or restore.
  router.patch('/:id', (req, res) => {
    const existing = findOr404(req.params.id);
    const body = req.body ?? {};
    const value = validateCategory({ ...pick(existing, EDITABLE_FIELDS), ...pick(body, EDITABLE_FIELDS) });

    let archivedAt = existing.archived_at;
    if (Object.hasOwn(body, 'archived')) {
      if (typeof body.archived !== 'boolean') throw new ValidationError({ archived: 'Має бути true або false' });
      archivedAt = body.archived ? (existing.archived_at ?? new Date().toISOString()) : null;
    }

    if (value.type !== existing.type && existing.transaction_count > 0) {
      throw new ValidationError({ type: 'Тип не можна змінити: категорія вже використовується в операціях' });
    }
    if (value.name !== existing.name || value.type !== existing.type) assertUniqueName(value, existing.id);

    updateRow.run({ ...value, archived_at: archivedAt, id: existing.id });
    res.json(getRow.get(existing.id));
  });

  // Deletes an unused category; a used one is archived instead so its transactions keep it.
  router.delete('/:id', (req, res) => {
    const existing = findOr404(req.params.id);
    const result = db.transaction(() => {
      if (existing.transaction_count > 0) {
        archiveRow.run(existing.id);
        return { deleted: false, archived: true, category: getRow.get(existing.id) };
      }
      deleteRow.run(existing.id);
      return { deleted: true, archived: false };
    })();
    res.json(result);
  });

  return router;
}
