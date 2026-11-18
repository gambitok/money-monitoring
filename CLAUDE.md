# CLAUDE.md

Контекст для Claude Code у цьому репозиторії.

**money-monitoring** — локальний облік доходів і витрат для одного користувача. Щоденне введення операцій, власні категорії, зведена таблиця і імпорт старих витрат з власної Excel-таблиці (`.xlsx`). Тільки гривня. Без авторизації, працює на localhost.

План і статус етапів: @docs/plan.md

## Як працювати

- Спілкуйся українською. Код, ідентифікатори, коміти англійською.
- Власник має 7+ років досвіду (PHP/Laravel, JS/TS, Vue). Базові речі не пояснюй.
- Роби один етап з плану за раз. Після етапу онови статус у `docs/plan.md`.
- Нових залежностей не додавай без потреби. Кожну нову залежність спочатку погодь.
- Коміть лише на прохання власника.

## Стек

- Node.js 24, ESM (`"type": "module"`).
- **Express 5.** Він сам ловить rejected async handlers, тому обгортка `route()` як у token-monitoring не потрібна.
- **better-sqlite3**: синхронний API, файл `data/money.db`, `journal_mode = WAL`, `foreign_keys = ON`.
- Фронтенд: vanilla JS + HTML + CSS у `public/`, без фреймворку і бандлера.
- Тести: вбудований `node:test`. Сервер піднімається на випадковому порту з БД у тимчасовому файлі, запити робляться через `fetch`.
- Порт за замовчуванням `3001` (порт 3000 зайнятий token-monitoring), можна змінити через `PORT`.

## Команди

- `npm install`, `npm start` → http://localhost:3001. `npm run dev` перезапускає сервер при зміні файлів (`node --watch`). Зміни в `public/` потребують лише оновлення сторінки.
- `npm test`: `node --test` знаходить `tests/*.test.js`. `tests/helpers.js` має `startTestServer()`, який створює тимчасову БД і повертає `{ db, baseUrl, close }`.
- `launch.ps1`: запускає сервер, якщо він не працює (перевіряє `/api/health`), і відкриває браузер.
- Змінні оточення: `PORT` (3001), `DB_FILE` (`data/money.db`).

## Модель даних

```sql
categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('income','expense')),
  color       TEXT,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (name, type)
)

transactions (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency     TEXT NOT NULL DEFAULT 'UAH',
  occurred_on  TEXT NOT NULL,              -- 'YYYY-MM-DD'
  category_id  INTEGER REFERENCES categories(id),
  description  TEXT,
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  import_hash  TEXT UNIQUE,                -- захист від дублікатів під час імпорту
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)
```

## Правила домену

- **Гроші зберігаються цілим числом у копійках** (`amount_minor`), float не використовуємо. Конвертація з введеного користувачем рядка і назад відбувається на межі системи (валідація API і форматування в UI).
- Знак суми не зберігаємо: напрям операції задає `type`, сума завжди більша за 0.
- Категорія необов'язкова. **Якщо категорії немає, опис обов'язковий.**
- Тип категорії має збігатися з типом операції.
- Категорію, до якої прив'язані операції, не видаляємо, а архівуємо (`archived_at`). Архівні категорії не показуються у формі, але залишаються у звітах.
- Дата операції — це календарний день без часу і часових поясів. За замовчуванням у формі стоїть сьогоднішня локальна дата.
- Агрегати (зведення, підсумки) рахуються в SQL (`GROUP BY`), а не в браузері.

## Схема коду

- `server.js`: тільки точка входу (відкриває БД, слухає порт, graceful shutdown).
- `src/app.js`: `createApp({ db })` збирає Express-застосунок (JSON-парсер, `/api/*`, JSON 404 для невідомих `/api`, статика, error handler). Тести імпортують саме його. Error handler віддає `err.status` з `err.message`, а для 5xx — загальне повідомлення.
- `src/db.js`: `openDb(file)` і `migrate(db, list)`. Масив `migrations` тільки доповнюється, номер версії = індекс + 1 і зберігається в `PRAGMA user_version`. Кожна міграція виконується у власній транзакції. Якщо БД новіша за код, `migrate` падає.

Цільові файли наступних етапів:
- `src/routes/*.js`: окремий файл для кожного ресурсу (`transactions`, `categories`, `summary`, `import`).
- `src/validate.js`: валідація вхідних даних і парсинг сум. Помилки повертаються як `400 { error, fields }`.
- `public/`: `index.html`, `app.js`, `styles.css`.

## Застереження

- `data/` у `.gitignore`, там лежать реальні дані власника. Ніколи не видаляй і не перезаписуй `data/money.db`. Тести працюють лише з тимчасовою БД.
- У фронтенді будь-який текст користувача (опис, назва категорії) вставляй через `textContent` або екрануй. Інтерполяція сирих значень у `innerHTML` заборонена.
- Багатокрокові записи (імпорт, масові дії) виконуй у `db.transaction(...)`.
