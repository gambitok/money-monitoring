// Average USD rate taken from the owner's own data: income descriptions written as
// "$2215 за курсом 43" (freelance, see the legacy import). Used to show "≈ $X" next to totals.
const USD_RATE_RE = /\$(\d+(?:,\d+)?) за курсом \d+(?:,\d+)?/;

/**
 * Returns usdRate({ from, to }) → { rate, source: 'period' | 'all' } | null.
 * from/to are inclusive 'YYYY-MM-DD' dates, either may be null (unbounded).
 * The rate is weighted (total UAH / total USD) over the period; when the period has no rated
 * income (e.g. 2024) the all-time average is used. null when no rate is known at all.
 */
export function createUsdRate(db) {
  const ratedIncome = db.prepare(`
    SELECT amount_minor, description FROM transactions
    WHERE type = 'income' AND description LIKE '%за курсом%'
      AND (@from IS NULL OR occurred_on >= @from)
      AND (@to IS NULL OR occurred_on <= @to)
  `);

  function weighted(params) {
    let uah = 0;
    let usd = 0;
    for (const row of ratedIncome.all(params)) {
      const m = USD_RATE_RE.exec(row.description);
      if (!m) continue;
      uah += row.amount_minor / 100;
      usd += Number(m[1].replace(',', '.'));
    }
    return usd > 0 ? Math.round((uah / usd) * 100) / 100 : null;
  }

  return function usdRate({ from = null, to = null } = {}) {
    const period = weighted({ from, to });
    if (period) return { rate: period, source: 'period' };
    const all = from || to ? weighted({ from: null, to: null }) : null;
    return all ? { rate: all, source: 'all' } : null;
  };
}
