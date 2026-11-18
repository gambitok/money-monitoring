const statusEl = document.getElementById('status');

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    statusEl.textContent = data.ok ? `БД OK · схема v${data.schemaVersion}` : 'БД недоступна';
    statusEl.classList.toggle('status-ok', data.ok);
  } catch {
    statusEl.textContent = 'сервер недоступний';
    statusEl.classList.add('status-error');
  }
}

checkHealth();
