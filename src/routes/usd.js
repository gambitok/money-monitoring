import { Router } from 'express';
import { createUsdRate } from '../usd.js';
import { ValidationError, isValidDate } from '../validate.js';

// GET /api/usd-rate?from&to (YYYY-MM-DD, optional, inclusive) → { usd: { rate, source } | null }.
// For views that build their totals client-side (the month view) but still show "≈ $X".
export function usdRouter(db) {
  const router = Router();
  const usdRate = createUsdRate(db);

  router.get('/', (req, res) => {
    const errors = {};
    const range = {};
    for (const key of ['from', 'to']) {
      const value = req.query[key];
      if (value === undefined || value === '') continue;
      if (isValidDate(value)) range[key] = value;
      else errors[key] = 'Дата має бути у форматі РРРР-ММ-ДД';
    }
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);
    res.json({ usd: usdRate(range) });
  });

  return router;
}
