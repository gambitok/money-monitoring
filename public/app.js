// Entry point: hash routing between views. No bundler: native ES modules.
import { $ } from './lib.js';
import * as categories from './categories-store.js';
import { initTransactionsView, showTransactionsView } from './transactions-view.js';
import { initCategoriesView, showCategoriesView } from './categories-view.js';

const views = {
  transactions: { el: $('viewTransactions'), show: showTransactionsView, title: 'Операції' },
  categories: { el: $('viewCategories'), show: showCategoriesView, title: 'Категорії' },
};

function currentView() {
  return location.hash === '#/categories' ? 'categories' : 'transactions';
}

function route() {
  const name = currentView();
  for (const [key, view] of Object.entries(views)) view.el.hidden = key !== name;
  for (const link of document.querySelectorAll('.app-nav a')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${views[name].title} · Money Monitoring`;
  views[name].show();
}

async function init() {
  initTransactionsView();
  initCategoriesView();
  try {
    await categories.load();
  } catch (err) {
    console.error('Не вдалося завантажити категорії', err);
  }
  window.addEventListener('hashchange', route);
  route();
}

init();
