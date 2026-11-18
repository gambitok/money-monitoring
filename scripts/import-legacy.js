// One-off import of the owner's old spreadsheet (see src/import/legacy-sheet.js).
//
//   node scripts/import-legacy.js <file.tsv> --year 2024 [--recategorize] [--commit] [--db data/money.db]
//
// Without --commit it only prints a report (dry run). With --commit it backs up the database
// file first and inserts everything in one transaction; already imported cells are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { RECATEGORIZE_RULES, legacyImportHash, parseLegacySheet } from '../src/import/legacy-sheet.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    year: { type: 'string' },
    db: { type: 'string', default: path.join('data', 'money.db') },
    commit: { type: 'boolean', default: false },
    recategorize: { type: 'boolean', default: false },
  },
});

const [file] = positionals;
const year = Number(values.year);
if (!file || !Number.isInteger(year)) {
  console.error('Usage: node scripts/import-legacy.js <file.tsv> --year 2024 [--recategorize] [--commit] [--db path]');
  process.exit(1);
}

const uah = (minor) => (minor / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 });
const { transactions, income, warnings, corrections, blocks } = parseLegacySheet(fs.readFileSync(file, 'utf8'), {
  year,
  recategorize: values.recategorize,
});

// ---------- report ----------

console.log(`\n=== ${file}, рік ${year} ===\n`);
let mismatches = 0;
for (const b of blocks) {
  const count = transactions.filter((t) => t.occurred_on.startsWith(b.month)).length;
  const sum = Object.values(b.parsedTotals).reduce((s, v) => s + v, 0);
  console.log(`${b.month}: ${count} операцій, ${uah(sum)} грн`);
  if (!b.sheetTotals) {
    console.log('   (у таблиці немає рядка підсумків — звірити нема з чим)');
    continue;
  }
  for (const column of new Set([...Object.keys(b.sheetTotals), ...Object.keys(b.parsedTotals)])) {
    const sheet = b.sheetTotals[column] ?? 0;
    const parsed = b.parsedTotals[column] ?? 0;
    if (sheet !== parsed) {
      mismatches++;
      console.log(`   ✗ ${column}: у таблиці ${uah(sheet)}, розпізнано ${uah(parsed)} (різниця ${uah(parsed - sheet)})`);
    }
  }
}
console.log(mismatches === 0 ? '\nПідсумки збігаються з рядками «разом» у таблиці.' : `\nРозбіжностей з підсумками: ${mismatches}`);

if (corrections.length) {
  console.log('\nВиправлені місяці (дати йшли назад):');
  const byWritten = Map.groupBy(corrections, (c) => `${c.written.slice(3)} → ${String(c.month).padStart(2, '0')}`);
  for (const [k, list] of byWritten) console.log(`   ${k}: ${list.length} рядків (рядки ${list[0].line}–${list.at(-1).line})`);
}
if (warnings.length) {
  console.log('\nПопередження:');
  for (const w of warnings) console.log(`   ${w}`);
}

const byCategory = Map.groupBy(transactions, (t) => t.category);
console.log('\nПо категоріях:');
for (const [category, list] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`   ${category}: ${list.length} шт, ${uah(list.reduce((s, t) => s + t.amount_minor, 0))} грн`);
}
const moved = transactions.filter((t) => t.recategorized);
if (moved.length) {
  console.log('\nПеренесено з «Інше»/«Комуналка» за описом:');
  for (const t of moved) console.log(`   ${t.occurred_on} ${uah(t.amount_minor)} «${t.description}» → ${t.category}`);
}
if (income.length) {
  console.log('\nДоходи (датовані 1-м числом місяця):');
  for (const [month, list] of Map.groupBy(income, (t) => t.occurred_on.slice(0, 7))) {
    const parts = list.map((t) => `${t.source} ${uah(t.amount_minor)}${t.description ? ` (${t.description})` : ''}`);
    const total = list.reduce((s, t) => s + t.amount_minor, 0);
    const sheet = blocks.find((b) => b.month === month)?.incomeTotal;
    console.log(`   ${month}: ${parts.join(', ')} = ${uah(total)}${sheet === total ? ' ✓' : ` ✗ у таблиці ${uah(sheet ?? 0)}`}`);
  }
}
const sumOf = (list) => uah(list.reduce((s, t) => s + t.amount_minor, 0));
console.log(`\nУсього: ${transactions.length} витрат на ${sumOf(transactions)} грн${income.length ? `, ${income.length} доходів на ${sumOf(income)} грн` : ''}`);

// ---------- commit ----------

if (!values.commit) {
  console.log('\nЦе пробний прогін. Щоб записати в БД, додай --commit.\n');
  process.exit(0);
}

if (fs.existsSync(values.db)) {
  const backup = `${values.db}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const tmp = openDb(values.db);
  tmp.pragma('wal_checkpoint(TRUNCATE)'); // fold the WAL into the main file before copying it
  tmp.close();
  fs.copyFileSync(values.db, backup);
  console.log(`\nБекап: ${backup}`);
}

const db = openDb(values.db);
const rows = [
  ...transactions.map((t) => ({ ...t, type: 'expense' })),
  ...income.map((t) => ({ ...t, type: 'income' })),
];
const loadCategoryIds = () => new Map(db.prepare('SELECT type, name, id FROM categories').all().map((c) => [`${c.type}:${c.name}`, c.id]));
let categoryIds = loadCategoryIds();
// Categories introduced by recategorize rules (e.g. «Криптовалюта») are created on first import.
const ruleCategories = new Set(RECATEGORIZE_RULES.map((r) => `expense:${r.category}`));
const missing = [...new Set(rows.map((t) => `${t.type}:${t.category}`))].filter((key) => !categoryIds.has(key));
const unknown = missing.filter((key) => !ruleCategories.has(key));
if (unknown.length) {
  console.error(`\nУ БД немає категорій: ${unknown.join(', ')}. Імпорт скасовано.`);
  process.exit(1);
}
for (const key of missing) {
  const name = key.slice('expense:'.length);
  db.prepare("INSERT INTO categories (type, name, color) VALUES ('expense', ?, '#0d9488')").run(name);
  console.log(`Створено категорію витрат «${name}»`);
}
categoryIds = loadCategoryIds();

const insert = db.prepare(`
  INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description, source, import_hash)
  VALUES (@type, @amount_minor, @occurred_on, @category_id, @description, 'import', @import_hash)
  ON CONFLICT (import_hash) DO NOTHING
`);
const inserted = db.transaction(() => {
  let n = 0;
  for (const t of rows) {
    n += insert.run({
      type: t.type,
      amount_minor: t.amount_minor,
      occurred_on: t.occurred_on,
      category_id: categoryIds.get(`${t.type}:${t.category}`),
      description: t.description,
      import_hash: legacyImportHash(t),
    }).changes;
  }
  return n;
})();
db.close();
console.log(`Записано: ${inserted}, пропущено як уже імпортовані: ${rows.length - inserted}\n`);
