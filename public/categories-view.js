// "Категорії" view: create, rename, recolor, archive/restore, delete.
import { $, h, plural, TYPE_LABELS } from './lib.js';
import * as categories from './categories-store.js';

const COUNT_WORDS = ['операція', 'операції', 'операцій'];
const NO_COLOR = '#9ca3af';

const els = {
  form: $('categoryForm'),
  typeButtons: [...document.querySelectorAll('#categoryForm .type-toggle [data-type]')],
  name: $('categoryName'),
  color: $('categoryColor'),
  nameError: $('categoryNameError'),
  message: $('categoryMessage'),
  lists: $('categoryLists'),
};

const state = {
  type: 'expense',
  editingId: null,
  rowError: null, // { id, text } shown under a row after a failed inline action
  archiveOpen: false,
};

function setType(type) {
  state.type = type;
  for (const btn of els.typeButtons) btn.setAttribute('aria-checked', String(btn.dataset.type === type));
  els.form.dataset.type = type;
  els.color.value = categories.nextColor(type);
}

let messageTimer;
function showMessage(text) {
  clearTimeout(messageTimer);
  els.message.textContent = text;
  if (text) messageTimer = setTimeout(() => { els.message.textContent = ''; }, 3000);
}

async function submitForm(event) {
  event.preventDefault();
  els.nameError.replaceChildren();
  els.name.removeAttribute('aria-invalid');
  try {
    const created = await categories.create({ name: els.name.value, type: state.type, color: els.color.value });
    els.name.value = '';
    els.color.value = categories.nextColor(state.type);
    showMessage(`Додано «${created.name}»`);
    els.name.focus();
  } catch (err) {
    els.name.setAttribute('aria-invalid', 'true');
    const conflict = err.status === 409 && categories.byId(err.body?.conflict_id);
    if (conflict?.archived_at) {
      els.nameError.replaceChildren(`«${conflict.name}» є в архіві. `,
        h('button', { type: 'button', class: 'link-btn', onclick: () => restore(conflict) }, 'Відновити'));
    } else {
      els.nameError.textContent = err.fields?.name ?? err.fields?.color ?? err.message;
    }
    els.name.focus();
  }
}

async function runRowAction(id, action) {
  state.rowError = null;
  try {
    await action();
  } catch (err) {
    state.rowError = { id, text: err.fields ? Object.values(err.fields).join('. ') : err.message };
    render();
  }
}

function restore(cat) {
  return runRowAction(cat.id, async () => {
    await categories.update(cat.id, { archived: false });
    els.nameError.replaceChildren();
    els.name.value = '';
    showMessage(`«${cat.name}» відновлено`);
  });
}

function saveName(cat, input) {
  const name = input.value;
  if (name.trim() === cat.name) {
    state.editingId = null;
    render();
    return;
  }
  return runRowAction(cat.id, async () => {
    await categories.update(cat.id, { name });
    state.editingId = null;
    render();
  });
}

function removeCategory(cat) {
  const question = cat.transaction_count > 0
    ? `Категорія «${cat.name}» використовується в ${plural(cat.transaction_count, COUNT_WORDS)}, тому її буде переміщено в архів. Операції збережуть категорію. Продовжити?`
    : `Видалити категорію «${cat.name}»?`;
  if (!confirm(question)) return;
  return runRowAction(cat.id, async () => {
    const result = await categories.remove(cat.id);
    showMessage(result.archived ? `«${cat.name}» переміщено в архів` : `«${cat.name}» видалено`);
  });
}

// ---------- rendering ----------

function render() {
  const all = categories.all();
  const archived = all.filter((c) => c.archived_at);

  // replaceChildren() would print a literal "false", so falsy parts are filtered out.
  els.lists.replaceChildren(...[
    h('div', { class: 'category-columns' },
      ['expense', 'income'].map((type) => {
        const items = all.filter((c) => c.type === type && !c.archived_at);
        return h('section', { class: 'category-column' },
          h('h3', { class: `category-column-title ${type}` }, TYPE_LABELS[type], h('span', { class: 'muted' }, ` · ${items.length}`)),
          items.length
            ? h('ul', { class: 'cat-rows' }, items.map(renderRow))
            : h('p', { class: 'empty' }, 'Поки немає категорій.'),
        );
      }),
    ),
    archived.length > 0 && h('details', {
      class: 'archive',
      open: state.archiveOpen,
      ontoggle: (e) => { state.archiveOpen = e.currentTarget.open; },
    },
      h('summary', {}, `Архів · ${archived.length}`),
      h('p', { class: 'muted archive-hint' }, 'Архівні категорії не показуються у формі, але залишаються в старих операціях і звітах.'),
      h('ul', { class: 'cat-rows' }, archived.map(renderArchivedRow)),
    ),
  ].filter(Boolean));

  if (state.editingId !== null) {
    const input = els.lists.querySelector('.cat-name-input');
    input?.focus();
    input?.select();
  }
}

function rowError(cat) {
  return state.rowError?.id === cat.id && h('p', { class: 'field-error cat-error' }, state.rowError.text);
}

function renderRow(cat) {
  const editing = state.editingId === cat.id;

  const swatch = h('input', {
    type: 'color',
    class: 'cat-swatch',
    value: cat.color ?? NO_COLOR,
    title: 'Змінити колір',
    'aria-label': `Колір категорії ${cat.name}`,
    onchange: (e) => runRowAction(cat.id, () => categories.update(cat.id, { color: e.currentTarget.value })),
  });

  let nameEl;
  if (editing) {
    const input = h('input', {
      class: 'cat-name-input',
      value: cat.name,
      maxlength: 60,
      'aria-label': 'Нова назва',
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveName(cat, input); }
        if (e.key === 'Escape') { state.editingId = null; state.rowError = null; render(); }
      },
    });
    nameEl = h('div', { class: 'cat-name-edit' },
      input,
      h('button', { type: 'button', class: 'btn-icon', title: 'Зберегти', 'aria-label': 'Зберегти', onclick: () => saveName(cat, input) }, '✓'),
      h('button', { type: 'button', class: 'btn-icon', title: 'Скасувати', 'aria-label': 'Скасувати', onclick: () => { state.editingId = null; state.rowError = null; render(); } }, '↩'),
    );
  } else {
    nameEl = h('span', { class: 'cat-name' }, cat.name);
  }

  return h('li', { class: 'cat-row' },
    swatch,
    nameEl,
    h('span', { class: 'cat-count muted' }, plural(cat.transaction_count, COUNT_WORDS)),
    h('div', { class: 'cat-actions' },
      !editing && h('button', {
        type: 'button', class: 'btn-icon', title: 'Перейменувати', 'aria-label': `Перейменувати ${cat.name}`,
        onclick: () => { state.editingId = cat.id; state.rowError = null; render(); },
      }, '✎'),
      h('button', {
        type: 'button', class: 'btn-icon danger',
        title: cat.transaction_count > 0 ? 'В архів' : 'Видалити',
        'aria-label': `${cat.transaction_count > 0 ? 'В архів' : 'Видалити'} ${cat.name}`,
        onclick: () => removeCategory(cat),
      }, '✕'),
    ),
    rowError(cat),
  );
}

function renderArchivedRow(cat) {
  return h('li', { class: 'cat-row is-archived' },
    h('span', { class: 'cat-dot', style: { '--chip-color': cat.color ?? NO_COLOR } }),
    h('span', { class: 'cat-name' }, cat.name, h('span', { class: 'muted' }, ` · ${TYPE_LABELS[cat.type].toLowerCase()}`)),
    h('span', { class: 'cat-count muted' }, plural(cat.transaction_count, COUNT_WORDS)),
    h('div', { class: 'cat-actions' },
      h('button', { type: 'button', class: 'btn-ghost btn-small', onclick: () => restore(cat) }, 'Відновити'),
      cat.transaction_count === 0 && h('button', {
        type: 'button', class: 'btn-icon danger', title: 'Видалити назавжди', 'aria-label': `Видалити ${cat.name}`,
        onclick: () => removeCategory(cat),
      }, '✕'),
    ),
    rowError(cat),
  );
}

export function initCategoriesView() {
  for (const btn of els.typeButtons) btn.addEventListener('click', () => setType(btn.dataset.type));
  els.form.addEventListener('submit', submitForm);
  categories.subscribe(render);
  setType('expense');
  render();
}

// Called when the view becomes visible: transaction counts may have changed.
export async function showCategoriesView() {
  els.nameError.replaceChildren();
  els.name.removeAttribute('aria-invalid');
  await categories.load();
  els.color.value = categories.nextColor(state.type);
  els.name.focus();
}
