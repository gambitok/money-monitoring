import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyImportHash, parseLegacySheet } from '../src/import/legacy-sheet.js';

const T = '\t';
const row = (...cells) => cells.join(T);

// A compressed copy of the real sheet's quirks.
const SHEET = [
  // April: Інше before Комуналка, no totals row.
  row('Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Інше', 'Комуналка', ''),
  row('29.04', '40', '103', '', '', '', '', '', '1200', 'вода'),
  row('30.04', '', '', '', '', '', '', '390', '', 'хостінг'),
  // May: normal order; totals row glued with the June header.
  row('Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', ''),
  row('30.05', '113', '', '', '', '', '', '', '160', 'lifecell'),
  row('31.05', '127', '', '35', '', '1990', '', '', '113', 'наушніки'),
  row('', '240', '0', '35', '0', '1990', '0', '0', '273', '', 'Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', ''),
  // "September" written with August dates after a real August.
  row('31.08', '280', '', '', '', '', '', '', '1700', 'юля'),
  row('01.08', '425', '', '403', '140'),
  row('02.08', '177', '115', '55', '', '', '1000', '', '', 'кофта'),
  row('', '', '', '', ''),
  row('', '602', '115', '458', '140', '0', '1000', '0', '0', '', 'Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', '', ''),
  // October: extra drinks column; then the totals glued to the first November date.
  row('02.10', '622', '200', '164', '', '', '', '', '28', 'кава стіки сільпо', 'зубровка джин'),
  row('05.10', '380', '', '', '', '2020', '', '', '', 'шава', 'абсолют груша'),
  row('', '1002', '200', '164', '0', '2020', '0', '0', '28', '', '341401.11', '532', '100', '', '231', '', '', '', '', 'сільпо піца тако', '', ''),
  row('02.11', '632', '', '500', '  '),
  row('', '1164', '100', '500', '231', '0', '0', '0', '0', '', '1995'),
  row('', '8000', '1500', '2500', '1000', '', '', '', '', '', '13000'), // budget: ignored
].join('\n');

const parse = (options = {}) => parseLegacySheet(SHEET, { year: 2024, ...options });

test('parses amounts in kopiyky with mapped categories', () => {
  const { transactions } = parse();
  const water = transactions.find((t) => t.occurred_on === '2024-04-29' && t.column === 'Комуналка');
  assert.deepEqual(
    { category: water.category, amount: water.amount_minor, description: water.description },
    { category: 'Комунальні платежі', amount: 120000, description: 'вода' },
  );
  const taxi = transactions.find((t) => t.column === 'Таксі');
  assert.equal(taxi.category, 'Транспорт');
});

test('every header remaps the columns (April has Інше before Комуналка)', () => {
  const { transactions } = parse();
  const hosting = transactions.find((t) => t.occurred_on === '2024-04-30');
  assert.equal(hosting.column, 'Інше');
  const lifecell = transactions.find((t) => t.occurred_on === '2024-05-30' && t.amount_minor === 16000);
  assert.equal(lifecell.column, 'Інше');
});

test('description goes to occasional columns, otherwise to Продукти', () => {
  const { transactions } = parse();
  const day = transactions.filter((t) => t.occurred_on === '2024-05-31');
  assert.equal(day.find((t) => t.column === 'Дім').description, 'наушніки');
  assert.equal(day.find((t) => t.column === 'Інше').description, 'наушніки');
  assert.equal(day.find((t) => t.column === 'Продукти').description, null);

  const sep2 = transactions.filter((t) => t.occurred_on === '2024-09-02');
  assert.equal(sep2.find((t) => t.column === 'Одяг').description, 'кофта');

  const nov1 = transactions.filter((t) => t.occurred_on === '2024-11-01');
  assert.equal(nov1.find((t) => t.column === 'Продукти').description, 'сільпо піца тако');
});

test('extra drinks column goes to Алкоголь, or to the main description without alcohol', () => {
  const { transactions } = parse();
  const oct2 = transactions.filter((t) => t.occurred_on === '2024-10-02');
  assert.equal(oct2.find((t) => t.column === 'Алкоголь').description, 'зубровка джин');
  assert.equal(oct2.find((t) => t.column === 'Інше').description, 'кава стіки сільпо');
  const oct5 = transactions.find((t) => t.occurred_on === '2024-10-05' && t.column === 'Дім');
  assert.equal(oct5.description, 'шава; абсолют груша');
});

test('dates going backwards are moved to the next month and reported', () => {
  const { transactions, corrections } = parse();
  assert.ok(transactions.some((t) => t.occurred_on === '2024-08-31'));
  assert.ok(transactions.some((t) => t.occurred_on === '2024-09-01' && t.amount_minor === 42500));
  assert.ok(transactions.some((t) => t.occurred_on === '2024-09-02'));
  assert.deepEqual(corrections.map((c) => [c.written, c.month]), [['01.08', 9], ['02.08', 9]]);
});

test('a date glued to the previous total is recovered', () => {
  const { transactions, warnings } = parse();
  const nov1 = transactions.filter((t) => t.occurred_on === '2024-11-01');
  assert.deepEqual(nov1.map((t) => [t.column, t.amount_minor]), [['Продукти', 53200], ['Цигарки', 10000], ['Таксі', 23100]]);
  assert.ok(warnings.some((w) => w.includes('01.11')));
});

test('sheet totals are captured per block and match parsed sums; budget rows are ignored', () => {
  const { blocks } = parse();
  assert.deepEqual(blocks.map((b) => b.month), ['2024-04', '2024-05', '2024-08', '2024-09', '2024-10', '2024-11']);
  assert.equal(blocks[0].sheetTotals, null);
  for (const b of blocks.filter((x) => x.sheetTotals && x.month !== '2024-08')) {
    for (const [column, sum] of Object.entries(b.sheetTotals)) {
      assert.equal(b.parsedTotals[column] ?? 0, sum, `${b.month} ${column}`);
    }
  }
  assert.equal(blocks.find((b) => b.month === '2024-11').sheetTotals['Продукти'], 116400, 'not the 8000 budget row');
});

test('whitespace-only cells are empty, not errors', () => {
  const { transactions, warnings } = parse();
  assert.equal(transactions.filter((t) => t.occurred_on === '2024-11-02').length, 2);
  assert.ok(!warnings.some((w) => w.includes('не схоже на суму')));
});

test('recategorize moves single-item descriptions only', () => {
  const plain = parse();
  assert.ok(plain.transactions.every((t) => !t.recategorized));

  const { transactions } = parse({ recategorize: true });
  assert.equal(transactions.find((t) => t.occurred_on === '2024-04-30').category, 'Підписки');
  assert.equal(transactions.find((t) => t.occurred_on === '2024-05-30' && t.column === 'Інше').category, 'Підписки');
  assert.equal(transactions.find((t) => t.occurred_on === '2024-05-31' && t.column === 'Інше').category, 'Інше');
});

test('import hash identifies a sheet cell', () => {
  const { transactions } = parse();
  const hashes = transactions.map(legacyImportHash);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.equal(legacyImportHash(transactions[0]), 'legacy:2024-04-29:Продукти');
});

// 2025 layout: restaurant column and income columns to the right, two different income layouts.
const SHEET_2025 = [
  // Feb-May style: USD, freelance UAH, токо it, хое, total in day 1; rate in day 2.
  row('Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', '', '', '', '', 'фріланс', 'токо it', 'хое', '', ''),
  row('01.02', '200', '', '', '', '', '', '', '255', 'lifecell', '', '', '2160', '88992', '23000', '14160', '126152', ''),
  row('02.02', '198', '', '', '', '', '', '', '', 'кава атб', '', '', '41,2'),
  row('', '398', '0', '0', '0', '0', '0', '0', '255', '', '653'),
  // Jul-Dec style: restaurant column, partial payments in rows 1-2, sums in row 3.
  row('0', 'Продукти', 'Цигарки', 'Алкоголь', 'Ресторан', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', '', '', '', '', 'долар', 'фріланс', 'хое', ''),
  row('01.07', '280', '', '', '700', '', '', '', '', '', 'суші', '', '', '', '41,2', '550', '8275'),
  row('02.07', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '510', '6600'),
  row('03.07', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '43672', '14875', '58547'),
  row('', '280', '0', '0', '700', '0', '0', '0', '0', '0', '980'),
  // August: only the state salary, freelance 0.
  row('Продукти', 'Цигарки', 'Алкоголь', 'Ресторан', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', '', '', '', '', 'долар', 'фріланс', 'хое', ''),
  row('01.08', '50', '', '', '', '', '', '', '', '', '', '', '', '', '41,2', '', '9140'),
  row('02.08', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '0', '9140', '9140'),
].join('\n');

test('restaurant column maps to the cafe category', () => {
  const { transactions, blocks } = parseLegacySheet(SHEET_2025, { year: 2025 });
  const sushi = transactions.find((t) => t.occurred_on === '2025-07-01' && t.column === 'Ресторан');
  assert.equal(sushi.category, 'Кафе, ресторани, доставка');
  assert.equal(sushi.amount_minor, 70000);
  assert.equal(blocks.find((b) => b.month === '2025-07').sheetTotals['Ресторан'], 70000);
});

test('income: salaries from their columns, freelance = total − salaries, dated the 1st', () => {
  const { income } = parseLegacySheet(SHEET_2025, { year: 2025 });
  const simple = income.map((t) => [t.occurred_on, t.category, t.amount_minor]);
  assert.deepEqual(simple, [
    ['2025-02-01', 'Зарплата (державна)', 1416000],
    ['2025-02-01', 'Зарплата (IT-компанія)', 2300000],
    ['2025-02-01', 'Фриланс', 8899200],
    ['2025-07-01', 'Зарплата (державна)', 1487500],
    ['2025-07-01', 'Фриланс', 4367200],
    ['2025-08-01', 'Зарплата (державна)', 914000],
  ]);
  assert.equal(income.find((t) => t.occurred_on === '2025-02-01' && t.source === 'фріланс').description, '$2160 за курсом 41,2');
  assert.equal(income.find((t) => t.occurred_on === '2025-07-01' && t.source === 'фріланс').description, '$1060 за курсом 41,2');
});

test('income import hash is per month and source', () => {
  const { income } = parseLegacySheet(SHEET_2025, { year: 2025 });
  assert.equal(legacyImportHash(income[0]), 'legacy-income:2025-02:хое');
});

test('2024 sheet has no income', () => {
  assert.deepEqual(parse().income, []);
});

test('recategorize: crypto rule matches anywhere in the description', () => {
  const sheet = [
    row('Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', ''),
    row('07.10', '1582', '', '', '', '', '', '', '17000', 'binance galya'),
    row('20.10', '', '', '', '', '', '', '', '1518', 'комісія біток'),
    row('21.10', '', '', '', '', '', '', '', '100', 'кава'),
  ].join('\n');
  const { transactions } = parseLegacySheet(sheet, { year: 2025, recategorize: true });
  const other = transactions.filter((t) => t.column === 'Інше').map((t) => t.category);
  assert.deepEqual(other, ['Криптовалюта', 'Криптовалюта', 'Інше']);
});

// 2026 layout: explicit categories, "Дата"/"Коментар" columns, integer USD rate,
// January written as "12", income sums row without a total cell.
const HEADER_2026 = ['Продукти', 'Цигарки', 'Алкоголь', 'Заклади', 'Транспорт', 'Дім', 'Одяг', 'Комуналка', 'Підписки', "Здоров'я", 'Інше'];
const SHEET_2026 = [
  row('', ...HEADER_2026, '', '', '', '', 'долар', 'фріланс', 'хое'),
  row('01.12', '', '', '', '', '', '', '', '150', '', '', '', 'xcity', '', '', '', '43', '511', '1000'),
  row('02.12', '60', '', '', '1975', '', '', '', '', '', '', '168', 'хінкальня steam', '', '', '', '', '852', '5200'),
  row('03.12', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '58609', '6200'),
  row('', '60', '0', '0', '1975', '0', '0', '0', '150', '0', '0', '168', '2353'),
  row('Дата', ...HEADER_2026, 'Коментар', '', '', '', 'долар', 'фріланс', 'хое', ''),
  row('01.02', '', '', '', '', '', '670', '', '', '300', '', '5039', 'USDT, вікно сітка', '', '', '', '44', '100', '500'),
  row('02.02', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '4400', '500', '4900'),
].join('\n');

test('2026: first block written as December before February is January', () => {
  const { transactions, corrections } = parseLegacySheet(SHEET_2026, { year: 2026 });
  assert.deepEqual([...new Set(transactions.map((t) => t.occurred_on.slice(0, 7)))], ['2026-01', '2026-02']);
  assert.equal(corrections.filter((c) => c.written.endsWith('.12')).length, 3);
});

test('2026: explicit category columns and the comment column', () => {
  const { transactions } = parseLegacySheet(SHEET_2026, { year: 2026 });
  const cafe = transactions.find((t) => t.column === 'Заклади');
  assert.equal(cafe.category, 'Кафе, ресторани, доставка');
  assert.equal(cafe.description, 'хінкальня steam');
  const sub = transactions.find((t) => t.column === 'Підписки');
  assert.equal(sub.category, 'Підписки');
  assert.equal(sub.description, 'USDT, вікно сітка');
});

test('2026: income with an integer rate and a sums row without total', () => {
  const { income } = parseLegacySheet(SHEET_2026, { year: 2026 });
  assert.deepEqual(income.map((t) => [t.occurred_on, t.source, t.amount_minor, t.description]), [
    ['2026-01-01', 'хое', 620000, null],
    ['2026-01-01', 'фріланс', 5860900, '$1363 за курсом 43'],
    ['2026-02-01', 'хое', 50000, null],
    ['2026-02-01', 'фріланс', 440000, '$100 за курсом 44'],
  ]);
});

test('2026: USDT in a multi-amount row moves only the Інше amount to crypto', () => {
  const { transactions } = parseLegacySheet(SHEET_2026, { year: 2026, recategorize: true });
  const feb1 = transactions.filter((t) => t.occurred_on === '2026-02-01');
  assert.equal(feb1.find((t) => t.column === 'Інше').category, 'Криптовалюта');
  assert.equal(feb1.find((t) => t.column === 'Дім').category, 'Товари для дому');
  assert.equal(feb1.find((t) => t.column === 'Підписки').category, 'Підписки');
});

test('empty template rows with impossible dates are skipped silently', () => {
  const sheet = [
    row('Продукти', 'Цигарки', 'Алкоголь', 'Таксі', 'Дім', 'Одяг', 'Комуналка', 'Інше', ''),
    row('30.11', '100'),
    row('31.11', '', '', '', '', '', '', '', '', ''),
  ].join('\n');
  const { transactions, warnings } = parseLegacySheet(sheet, { year: 2026 });
  assert.equal(transactions.length, 1);
  assert.deepEqual(warnings, []);
});
