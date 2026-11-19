import { Router } from 'express';
import { TYPES, ValidationError, parseAmount } from '../validate.js';

// Monthly plans. The editor saves the whole set at once, so PUT replaces all plans.
//   GET /api/budgets → { items: [{ id, type, category_id, category_name, category_color, amount_minor }] }
//   PUT /api/budgets { items: [{ type, category_id | null, amount }] } → same shape.
// An item with an empty amount is simply not a plan; category_id null is the overall plan.
export function budgetsRouter(db) {
  const router = Router();

  const list = db.prepare(`
    SELECT b.id, b.type, b.category_id, c.name AS category_name, c.color AS category_color, b.amount_minor
    FROM budgets b LEFT JOIN categories c ON c.id = b.category_id
    ORDER BY b.type, b.category_id IS NOT NULL, c.id
  `);
  const getCategory = db.prepare('SELECT id, type FROM categories WHERE id = ?');
  const insert = db.prepare('INSERT INTO budgets (type, category_id, amount_minor) VALUES (@type, @category_id, @amount_minor)');

  router.get('/', (req, res) => {
    res.json({ items: list.all() });
  });

  router.put('/', (req, res) => {
    const input = req.body?.items;
    if (!Array.isArray(input)) throw new ValidationError({ items: 'Очікується список планів' });

    const errors = {};
    const rows = [];
    const seen = new Set();
    input.forEach((item, i) => {
      const key = `items.${i}`;
      if (!item || typeof item !== 'object') { errors[key] = 'Некоректний план'; return; }
      if (item.amount === null || item.amount === undefined || String(item.amount).trim() === '') return;

      if (!TYPES.includes(item.type)) { errors[key] = 'Тип має бути income або expense'; return; }
      const amount = parseAmount(typeof item.amount === 'number' ? item.amount : String(item.amount));
      if (amount === null) { errors[key] = 'Сума має бути додатним числом, не більше 2 знаків після коми'; return; }

      let categoryId = null;
      if (item.category_id !== null && item.category_id !== undefined) {
        const category = Number.isSafeInteger(item.category_id) ? getCategory.get(item.category_id) : null;
        if (!category) { errors[key] = 'Категорію не знайдено'; return; }
        if (category.type !== item.type) { errors[key] = 'Тип категорії не збігається з типом плану'; return; }
        categoryId = category.id;
      }

      const unique = `${item.type}:${categoryId ?? 'total'}`;
      if (seen.has(unique)) { errors[key] = 'План для цієї категорії вказано двічі'; return; }
      seen.add(unique);
      rows.push({ type: item.type, category_id: categoryId, amount_minor: amount });
    });
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);

    db.transaction(() => {
      db.prepare('DELETE FROM budgets').run();
      for (const row of rows) insert.run(row);
    })();
    res.json({ items: list.all() });
  });

  return router;
}
