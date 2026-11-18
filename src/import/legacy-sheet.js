// Parser for the owner's old spreadsheet: one block per month, a header row of category columns,
// one row per day ("DD.MM", amounts in whole hryvnias, then a free-text description), and a
// totals row at the end of the block. Copied from Excel as tab-separated text.
//
// Quirks of the real data this handles (see tests/legacy-sheet.test.js):
// - column order differs between blocks, so every header row remaps the columns;
// - a totals row and the next block's header can share one line;
// - a block may lack its header (it inherits the previous one);
// - a date can be glued to the previous total ("3583101.11" = total 35831 + "01.11");
// - a block may carry the wrong month in its dates (September written as "01.08".."30.08"):
//   a date that goes backwards is moved to the next month and reported;
// - 2025 adds a "Ресторани"/"Ресторан" column and income columns to the right (see INCOME_COLUMNS);
// - extra rows after a totals row (monthly budget/plan) are ignored;
// - an extra text column after the description (alcohol details) goes to the alcohol transaction.

export const LEGACY_COLUMNS = Object.freeze({
  'Продукти': 'Продукти',
  'Цигарки': 'Цигарки',
  'Алкоголь': 'Алкоголь',
  'Ресторани': 'Кафе, ресторани, доставка',
  'Ресторан': 'Кафе, ресторани, доставка',
  'Таксі': 'Транспорт',
  // 2026 header: explicit categories.
  'Заклади': 'Кафе, ресторани, доставка',
  'Транспорт': 'Транспорт',
  'Підписки': 'Підписки',
  "Здоров'я": "Здоров'я",
  'Дім': 'Товари для дому',
  'Одяг': 'Одяг',
  'Комуналка': 'Комунальні платежі',
  'Інше': 'Інше',
});

// Income columns (2025+). Their layout changed from month to month (USD in one column, UAH in
// another, partial payments in rows 1-4, sums in row 5), so income is taken from the block's
// income totals row: the row with a number right after the last income column. There
// хое and токо it are read from their columns and freelance = total − хое − токо it,
// which holds for every layout seen. A decimal 30..60 in the income area is the USD rate.
export const INCOME_COLUMNS = Object.freeze({
  'хое': 'Зарплата (державна)',
  'токо it': 'Зарплата (IT-компанія)',
  'фріланс': 'Фриланс',
});
const INCOME_HEADER_NAMES = ['хое', 'токо it', 'фріланс', 'долар', 'usd'];

// Columns whose spending is "occasional": the row description most likely explains them.
const DESCRIBED_COLUMNS = ['Інше', 'Дім', 'Одяг', 'Комуналка', 'Ресторани', 'Ресторан', 'Заклади', 'Підписки', "Здоров'я"];

// Optional: move a transaction to a more specific category when its whole description is
// one of these words (case-insensitive). Multi-item descriptions are left alone.
export const RECATEGORIZE_RULES = Object.freeze([
  { category: 'Підписки', words: ['lifecell', 'лайфсел', 'life', 'лайф', 'київстар', 'kyivstar', 'хостінг', 'домен', 'phpstorm', 'ютуб музика', 'zoho', 'chatgpt', 'копілот', 'нетфлікс', 'мегого', 'мегого 3 міс'] },
  { category: "Здоров'я", words: ['аптека', 'apteka', 'стоматолог', 'поліклініка', 'лікар', 'медкомісія', 'зуб', 'ліки'] },
  // Owner's decision (2025 import): crypto purchases and fees get their own expense category,
  // matched anywhere in the description ("binance galya").
  { category: 'Криптовалюта', contains: ['binance', 'біток', 'usdt'] },
]);

const DATE_RE = /^(\d{2})\.(\d{2})$/;
const GLUED_DATE_RE = /^\d+(\d{2}\.\d{2})$/;
const AMOUNT_RE = /^\d+(?:[.,]\d{1,2})?$/;

function parseAmountMinor(cell) {
  const s = cell.replace(/\s/g, '');
  if (s === '' || s === '0') return null;
  if (!AMOUNT_RE.test(s)) return undefined;
  const [int, frac = ''] = s.replace(',', '.').split('.');
  return Number(int) * 100 + Number(frac.padEnd(2, '0'));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {string} text tab-separated sheet text
 * @param {{ year: number, recategorize?: boolean }} options
 * @returns {{ transactions, warnings, corrections, blocks }}
 *   transactions: { occurred_on, column, category, amount_minor, description, source_line }
 *   blocks: per month { month, sheetTotals: {column: minor} | null, parsedTotals: {column: minor} }
 */
export function parseLegacySheet(text, { year, recategorize = false }) {
  const transactions = [];
  const income = [];
  const warnings = [];
  const corrections = [];
  const blocks = [];

  let header = null; // column names in sheet order
  let incomeCols = null; // { name: data cell index } from the current header
  let block = null;
  let last = null; // { month, day } of the previous date row

  const lines = text.replace(/\r/g, '').split('\n');

  // The first block can carry a month copied from a template ("01.12".."31.12" before "01.02"):
  // if the first written month is later than the next one, it is the month before the next one.
  const writtenMonths = lines
    .map((l) => l.split('\t').map((c) => c.trim()))
    .map((c) => (DATE_RE.test(c[0]) ? c[0] : c.find((x) => GLUED_DATE_RE.test(x))?.match(GLUED_DATE_RE)[1]))
    .filter(Boolean)
    .map((d) => Number(d.slice(3)));
  const nextMonth = writtenMonths.find((m) => m !== writtenMonths[0]);
  const firstBlockFix = writtenMonths.length && nextMonth > 1 && writtenMonths[0] > nextMonth
    ? { written: writtenMonths[0], month: nextMonth - 1, active: false }
    : null;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    let cells = line.split('\t').map((c) => c.trim());
    if (cells.every((c) => c === '')) return;

    // A header can start anywhere in the line (after a totals row on the same line).
    const headerAt = cells.findIndex((c) => Object.hasOwn(LEGACY_COLUMNS, c));
    const gluedAt = cells.findIndex((c) => GLUED_DATE_RE.test(c));
    const rowStartsWithDate = DATE_RE.test(cells[0]);

    // Leading totals row: "", n1, n2, ... (optionally followed by a header or a glued date).
    if (!rowStartsWithDate && cells[0] === '' && cells[1] !== undefined && AMOUNT_RE.test(cells[1].replace(/\s/g, ''))) {
      if (block && !block.closed) {
        if (!header) warnings.push(`Рядок ${lineNo}: підсумки до заголовка`);
        else {
          block.sheetTotals = {};
          header.forEach((name, i) => {
            block.sheetTotals[name] = parseAmountMinor(cells[i + 1] ?? '') ?? 0;
          });
        }
        block.closed = true; // later numeric rows in this block are a budget/plan, not data
      }
    }

    if (headerAt !== -1) {
      header = [];
      for (let i = headerAt; i < cells.length && Object.hasOwn(LEGACY_COLUMNS, cells[i]); i++) header.push(cells[i]);
      incomeCols = {};
      cells.forEach((c, i) => {
        if (i > headerAt && INCOME_HEADER_NAMES.includes(c)) incomeCols[c] = i - headerAt + 1;
      });
      if (Object.keys(incomeCols).length === 0) incomeCols = null;
      return;
    }

    if (gluedAt !== -1 && !rowStartsWithDate) {
      cells = [cells[gluedAt].match(GLUED_DATE_RE)[1], ...cells.slice(gluedAt + 1)];
      warnings.push(`Рядок ${lineNo}: дату «${cells[0]}» відокремлено від підсумку`);
    } else if (!rowStartsWithDate) {
      return; // totals / budget / unknown row, already handled above
    }

    if (!header) {
      warnings.push(`Рядок ${lineNo}: дані до першого заголовка пропущено`);
      return;
    }

    const [, dd, mm] = cells[0].match(DATE_RE);
    let day = Number(dd);
    let month = Number(mm);
    if (firstBlockFix && !last) firstBlockFix.active = month === firstBlockFix.written;
    if (firstBlockFix?.active && month === firstBlockFix.written) {
      corrections.push({ line: lineNo, written: cells[0], month: firstBlockFix.month });
      month = firstBlockFix.month;
    } else {
      if (firstBlockFix) firstBlockFix.active = false;
      if (last && (month < last.month || (month === last.month && day < last.day))) {
        // Dates went backwards: we are in the next month (or still in the month we already fixed).
        const fixed = day >= last.day && month < last.month ? last.month : last.month + 1;
        corrections.push({ line: lineNo, written: cells[0], month: fixed });
        month = fixed;
      }
    }
    const hasAmounts = header.some((_, i) => (cells[i + 1] ?? '') !== '');
    const date = new Date(Date.UTC(year, month - 1, day));
    if (month > 12 || day < 1 || day > 31 || date.getUTCMonth() !== month - 1) {
      // Template rows like "31.10" in a 30-day month are empty; only report rows with data.
      if (hasAmounts) warnings.push(`Рядок ${lineNo}: дати ${pad(day)}.${pad(month)}.${year} не існує`);
      return;
    }
    last = { month, day };

    if (!block || block.monthNo !== month) {
      block = { month: `${year}-${pad(month)}`, monthNo: month, sheetTotals: null, parsedTotals: {}, closed: false };
      blocks.push(block);
    }
    // A new block of dates reopens totals tracking even if the previous totals were glued.
    block.closed = false;

    const occurredOn = `${year}-${pad(month)}-${pad(day)}`;
    if (incomeCols) collectIncome(block, cells, incomeCols, lineNo);
    const description = cells[header.length + 1] || null;
    const extra = cells[header.length + 2] || null;

    const rowTx = [];
    header.forEach((column, i) => {
      const raw = cells[i + 1] ?? '';
      const amount = parseAmountMinor(raw);
      if (amount === undefined) {
        warnings.push(`Рядок ${lineNo}: «${raw}» у колонці ${column} не схоже на суму`);
        return;
      }
      if (amount === null) return;
      block.parsedTotals[column] = (block.parsedTotals[column] ?? 0) + amount;
      rowTx.push({ occurred_on: occurredOn, column, category: LEGACY_COLUMNS[column], amount_minor: amount, description: null, source_line: lineNo });
    });

    if (rowTx.length === 0) {
      if (description) warnings.push(`Рядок ${lineNo}: опис «${description}» без сум пропущено`);
      return;
    }

    const described = rowTx.filter((t) => DESCRIBED_COLUMNS.includes(t.column));
    const targets = described.length > 0 ? described : [rowTx.find((t) => t.column === 'Продукти') ?? rowTx[0]];
    if (description) for (const t of targets) t.description = description;

    if (extra) {
      // The extra column lists drinks; without an alcohol amount keep it with the main description.
      const alcohol = rowTx.find((t) => t.column === 'Алкоголь');
      for (const t of alcohol ? [alcohol] : targets) t.description = t.description ? `${t.description}; ${extra}` : extra;
    }

    // Only when the description clearly belongs to a single amount: with two described amounts
    // (e.g. "Інше" 95 and "Комуналка" 160, "лайфсел") we cannot tell which one it explains.
    if (recategorize && description) {
      const desc = description.toLocaleLowerCase('uk').trim();
      // "contains" rules (crypto) are specific enough to apply to the "Інше" amount even when the
      // row has other described amounts ("USDT, вікно сітка": Дім 670 + Інше 5039).
      const containsRule = RECATEGORIZE_RULES.find((r) => r.contains?.some((w) => desc.includes(w)));
      const other = targets.find((t) => t.column === 'Інше');
      if (containsRule && other) {
        other.category = containsRule.category;
        other.recategorized = true;
      } else if (targets.length === 1 && ['Інше', 'Комуналка'].includes(targets[0].column)) {
        const rule = RECATEGORIZE_RULES.find((r) => r.words?.includes(desc) || r.contains?.some((w) => desc.includes(w)));
        if (rule) {
          targets[0].category = rule.category;
          targets[0].recategorized = true;
        }
      }
    }

    transactions.push(...rowTx);
  });

  for (const b of blocks) {
    delete b.closed;
    const inc = b.income;
    delete b.income;
    if (!inc?.total) continue;
    const { values, total, rate, lineNo } = inc;
    const salaries = (values['хое'] ?? 0) + (values['токо it'] ?? 0);
    const freelance = total - salaries;
    if (freelance < 0) {
      warnings.push(`Рядок ${lineNo}: доходи разом менші за суму зарплат`);
      continue;
    }
    const occurredOn = `${b.month}-01`;
    for (const name of ['хое', 'токо it']) {
      if (values[name]) income.push({ occurred_on: occurredOn, source: name, category: INCOME_COLUMNS[name], amount_minor: values[name], description: null, source_line: lineNo });
    }
    if (freelance > 0) {
      const usd = rate ? Math.round((freelance / rate) * 100) / 100 : null;
      income.push({
        occurred_on: occurredOn, source: 'фріланс', category: INCOME_COLUMNS['фріланс'], amount_minor: freelance,
        // Plain digits (no locale grouping) so the description stays searchable: "$2160 за курсом 41,2".
        description: usd ? `$${String(usd).replace('.', ',')} за курсом ${String(rate / 100).replace('.', ',')}` : null,
        source_line: lineNo,
      });
    }
    b.incomeTotal = total;
  }
  return { transactions, income, warnings, corrections, blocks };
}

// Remembers the block's USD rate and its income totals row (see INCOME_COLUMNS).
function collectIncome(block, cells, incomeCols, lineNo) {
  const indexes = Object.values(incomeCols);
  const first = Math.min(...indexes) - 2;
  const totalIdx = Math.max(...indexes) + 1;
  block.income ??= { values: {}, total: 0, rate: null, lineNo, hoeRunning: 0 };
  const inc = block.income;
  // Rate: a decimal 30..60 anywhere in the income area ("41,2"), or a whole number in the
  // USD column itself ("43" in 2026), where it cannot be mistaken for a payment.
  const usdIdx = incomeCols['долар'] ?? incomeCols['usd'];
  for (let i = first; i <= totalIdx; i++) {
    const v = cells[i] ?? '';
    const n = Number(v.replace(',', '.'));
    const looksLikeRate = /^\d{2},\d{1,2}$/.test(v) || (i === usdIdx && /^\d{2}$/.test(v));
    if (looksLikeRate && n >= 30 && n <= 60) inc.rate ??= parseAmountMinor(v);
  }

  const total = parseAmountMinor(cells[totalIdx] ?? '');
  const hoe = incomeCols['хое'] !== undefined ? parseAmountMinor(cells[incomeCols['хое']] ?? '') : null;
  if (total) {
    inc.total = total;
    inc.lineNo = lineNo;
    for (const name of ['хое', 'токо it']) {
      if (incomeCols[name] !== undefined) inc.values[name] = parseAmountMinor(cells[incomeCols[name]] ?? '') ?? 0;
    }
  } else if (hoe && !inc.total && inc.hoeRunning > 0 && hoe === inc.hoeRunning) {
    // No "total" cell (January 2026): the sums row is the one whose хое equals the payments above.
    const freelance = incomeCols['фріланс'] !== undefined ? parseAmountMinor(cells[incomeCols['фріланс']] ?? '') ?? 0 : 0;
    inc.total = hoe + freelance;
    inc.values['хое'] = hoe;
    inc.lineNo = lineNo;
  } else if (hoe) {
    inc.hoeRunning += hoe;
  }
}

// Stable identity of a sheet cell, so re-running the import never duplicates rows.
export function legacyImportHash(t) {
  return t.source ? `legacy-income:${t.occurred_on.slice(0, 7)}:${t.source}` : `legacy:${t.occurred_on}:${t.column}`;
}
