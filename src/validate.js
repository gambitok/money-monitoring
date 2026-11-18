// Input validation at the API boundary. Money is converted to integer minor units (kopiyky) here
// and nowhere else; floats never reach the database.

export const TYPES = ['income', 'expense'];

// 999 999 999,99 UAH. Far beyond any personal transaction, far below Number.MAX_SAFE_INTEGER.
export const MAX_AMOUNT_MINOR = 99_999_999_999;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_CATEGORY_NAME_LENGTH = 60;

export class ValidationError extends Error {
  constructor(fields) {
    super('Validation failed');
    this.status = 400;
    this.fields = fields;
  }
}

// Accepts what people type: "1234", "1 234,50", "1234.5", "1,234.50", "1.234,50".
// Spaces (incl. NBSP and narrow NBSP from Excel/locale formatting) are thousand separators.
// With both "," and "." present, the last one is the decimal separator.
// Returns integer kopiyky, or null when the input is not a positive amount with at most 2 decimals.
export function parseAmount(input) {
  if (typeof input === 'number') return parseAmountNumber(input);
  if (typeof input !== 'string') return null;

  let s = input.replace(/[\s  ]/g, '');
  if (s === '') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    const i = Math.max(lastComma, lastDot);
    const intPart = s.slice(0, i);
    // The integer part must be properly grouped ("1,234,567"), otherwise the input is ambiguous.
    if (!new RegExp(`^\\d{1,3}(\\${groupSep}\\d{3})+$`).test(intPart)) return null;
    s = `${intPart.replaceAll(groupSep, '')}.${s.slice(i + 1)}`;
  } else {
    // A single separator is decimal. "1,234" thus has 3 decimals and is rejected, not read as 1234.
    s = s.replace(',', '.');
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!match) return null;

  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return minor > 0 && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

function parseAmountNumber(n) {
  if (!Number.isFinite(n)) return null;
  const minor = Math.round(n * 100);
  // Reject sub-kopiyka precision, but tolerate float noise like 0.1 + 0.2.
  if (Math.abs(n * 100 - minor) > 1e-6) return null;
  return minor > 0 && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

// Calendar date without time: "YYYY-MM-DD" that actually exists (no Feb 30).
export function isValidDate(input) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const [y, m, d] = input.split('-').map(Number);
  if (y < 1900 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseId(input) {
  if (input === null || input === undefined || input === '') return null;
  const n = typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : input;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function cleanText(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return undefined;
  const s = input.trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

// Validates a complete transaction (for PATCH, merge the stored row with the patch first, so the
// "no category requires a description" rule sees the final state).
// Does not check that the category exists or matches the type: that needs the database.
export function validateTransaction(input) {
  const errors = {};
  const value = {};

  if (TYPES.includes(input.type)) value.type = input.type;
  else errors.type = 'Тип має бути income або expense';

  const amount = input.amount_minor !== undefined
    ? (Number.isSafeInteger(input.amount_minor) && input.amount_minor > 0
      && input.amount_minor <= MAX_AMOUNT_MINOR ? input.amount_minor : null)
    : parseAmount(input.amount);
  if (amount !== null) value.amount_minor = amount;
  else errors.amount = 'Сума має бути додатним числом, не більше 2 знаків після коми';

  if (isValidDate(input.occurred_on)) value.occurred_on = input.occurred_on;
  else errors.occurred_on = 'Дата має бути у форматі РРРР-ММ-ДД';

  const categoryId = parseId(input.category_id);
  if (categoryId !== undefined) value.category_id = categoryId;
  else errors.category_id = 'Некоректна категорія';

  const description = cleanText(input.description);
  if (description === undefined) errors.description = 'Опис має бути текстом';
  else if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Опис довший за ${MAX_DESCRIPTION_LENGTH} символів`;
  } else {
    value.description = description;
    if (value.category_id === null && description === null && !errors.category_id) {
      errors.description = 'Без категорії опис обов\'язковий';
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return value;
}

export function validateCategory(input) {
  const errors = {};
  const value = {};

  const name = cleanText(input.name);
  if (!name) errors.name = 'Назва обов\'язкова';
  else if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    errors.name = `Назва довша за ${MAX_CATEGORY_NAME_LENGTH} символів`;
  } else value.name = name;

  if (TYPES.includes(input.type)) value.type = input.type;
  else errors.type = 'Тип має бути income або expense';

  if (input.color === undefined || input.color === null || input.color === '') value.color = null;
  else if (typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color)) {
    value.color = input.color.toLowerCase();
  } else errors.color = 'Колір має бути у форматі #rrggbb';

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return value;
}
