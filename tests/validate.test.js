import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AMOUNT_MINOR,
  ValidationError,
  isValidDate,
  parseAmount,
  validateCategory,
  validateTransaction,
} from '../src/validate.js';

test('parseAmount: accepted inputs', () => {
  const cases = {
    '1': 100,
    '1234': 123400,
    '0.01': 1,
    '0,5': 50,
    '12,34': 1234,
    '12.30': 1230,
    '1 234,50': 123450,
    '1 234,50': 123450, // NBSP
    '1 234,50': 123450, // narrow NBSP (uk-UA Intl format)
    '  42  ': 4200,
    '1,234.50': 123450,
    '1.234,50': 123450,
    '1,234,567.8': 123456780,
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(parseAmount(input), expected, `parseAmount(${JSON.stringify(input)})`);
  }
});

test('parseAmount: rejected inputs', () => {
  const cases = [
    '', ' ', '0', '0,00', '-5', '+5', '1,234', '1.234', '1,2345', '1.2.3', '1.234.567',
    '12a', 'abc', '1e3', '1,23.45', '12,34.56', '.5', '5.', '999999999999',
    null, undefined, {}, [], true,
  ];
  for (const input of cases) {
    assert.equal(parseAmount(input), null, `parseAmount(${JSON.stringify(input)})`);
  }
});

test('parseAmount: numbers', () => {
  assert.equal(parseAmount(12.5), 1250);
  assert.equal(parseAmount(0.1 + 0.2), 30); // float noise is tolerated
  assert.equal(parseAmount(19.99), 1999);
  assert.equal(parseAmount(1.005), null); // sub-kopiyka precision
  assert.equal(parseAmount(0), null);
  assert.equal(parseAmount(-1), null);
  assert.equal(parseAmount(Number.NaN), null);
  assert.equal(parseAmount(Infinity), null);
  assert.equal(parseAmount(MAX_AMOUNT_MINOR / 100), MAX_AMOUNT_MINOR);
  assert.equal(parseAmount(MAX_AMOUNT_MINOR / 100 + 1), null);
});

test('isValidDate', () => {
  for (const ok of ['2026-11-18', '2024-02-29', '1900-01-01', '2100-12-31']) {
    assert.equal(isValidDate(ok), true, ok);
  }
  for (const bad of ['2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-01',
    '18.11.2026', '2026-11-18T10:00', '1899-12-31', '', null, 20261118]) {
    assert.equal(isValidDate(bad), false, String(bad));
  }
});

const base = { type: 'expense', amount: '150,50', occurred_on: '2026-11-18', category_id: 3 };

function fieldsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.status, 400);
    return err.fields;
  }
  assert.fail('expected ValidationError');
}

test('validateTransaction: valid input is normalized', () => {
  assert.deepEqual(validateTransaction({ ...base, category_id: '3', description: '  кава   з  собою ' }), {
    type: 'expense',
    amount_minor: 15050,
    occurred_on: '2026-11-18',
    category_id: 3,
    description: 'кава з собою',
  });
});

test('validateTransaction: amount_minor is accepted as is (for merged PATCH rows)', () => {
  const { amount, ...rest } = base;
  assert.equal(validateTransaction({ ...rest, amount_minor: 999 }).amount_minor, 999);
  assert.ok(fieldsOf(() => validateTransaction({ ...rest, amount_minor: 1.5 })).amount);
});

test('validateTransaction: without category a description is required', () => {
  const fields = fieldsOf(() => validateTransaction({ ...base, category_id: null, description: '   ' }));
  assert.deepEqual(Object.keys(fields), ['description']);

  const ok = validateTransaction({ ...base, category_id: '', description: 'подарунок' });
  assert.equal(ok.category_id, null);
  assert.equal(ok.description, 'подарунок');
});

test('validateTransaction: reports every invalid field at once', () => {
  const fields = fieldsOf(() => validateTransaction({
    type: 'transfer', amount: '-1', occurred_on: '2026-02-30', category_id: 'x', description: 5,
  }));
  assert.deepEqual(Object.keys(fields).sort(), ['amount', 'category_id', 'description', 'occurred_on', 'type']);
});

test('validateTransaction: empty amount gets a short message', () => {
  assert.equal(fieldsOf(() => validateTransaction({ ...base, amount: '  ' })).amount, 'Вкажіть суму');
  assert.match(fieldsOf(() => validateTransaction({ ...base, amount: 'abc' })).amount, /додатним/);
});

test('validateTransaction: description length limit', () => {
  assert.ok(fieldsOf(() => validateTransaction({ ...base, description: 'a'.repeat(501) })).description);
  assert.equal(validateTransaction({ ...base, description: 'a'.repeat(500) }).description.length, 500);
});

test('validateCategory', () => {
  assert.deepEqual(validateCategory({ name: '  Їжа ', type: 'expense', color: '#AABBCC' }), {
    name: 'Їжа', type: 'expense', color: '#aabbcc',
  });
  assert.equal(validateCategory({ name: 'Зарплата', type: 'income' }).color, null);

  const fields = fieldsOf(() => validateCategory({ name: ' ', type: 'x', color: 'red' }));
  assert.deepEqual(Object.keys(fields).sort(), ['color', 'name', 'type']);
  assert.ok(fieldsOf(() => validateCategory({ name: 'a'.repeat(61), type: 'income' })).name);
});
