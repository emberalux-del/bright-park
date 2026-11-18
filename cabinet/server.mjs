import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const env = process.env;
const origin = new URL(env.APP_ORIGIN ?? 'http://localhost:3000');
const token = env.TELEGRAM_BOT_TOKEN;
const bot = env.TELEGRAM_BOT_USERNAME;
const shortName = env.TELEGRAM_APP_SHORT_NAME ?? '';
const telegramName = /^[A-Za-z0-9_]{1,64}$/;
if (!token || !telegramName.test(bot ?? '') ||
    (shortName && !telegramName.test(shortName)) ||
    !env.ADMIN_USERNAME || env.ADMIN_USERNAME.includes(':') ||
    (env.ADMIN_PASSWORD?.length ?? 0) < 24 ||
    (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) {
  throw new Error('Set Telegram bot credentials, APP_ORIGIN and an admin password of at least 24 characters.');
}
const botLink = 'https://t.me/' + bot + (shortName ? '/' + shortName : '');
const databasePath = env.DB_PATH ?? 'data/bright-park.sqlite';
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
process.umask(0o077);
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS plots (number TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY, telegram_id TEXT NOT NULL,
    name TEXT NOT NULL, phone TEXT NOT NULL, requested_plot TEXT NOT NULL,
    plot TEXT REFERENCES plots(number),
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','revoked')),
    source TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, decided_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_application
    ON applications(telegram_id) WHERE status IN ('pending','approved');
  CREATE TABLE IF NOT EXISTS invites (
    digest TEXT PRIMARY KEY, plot TEXT NOT NULL REFERENCES plots(number),
    expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER
  );
`);

const assets = {
  '/': ['resident.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/cabinet.css': ['cabinet.css', 'text/css; charset=utf-8'],
  '/cabinet.js': ['cabinet.js', 'text/javascript; charset=utf-8'],
};
for (const asset of Object.values(assets)) asset[0] = readFileSync(new URL(asset[0], import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
const telegramKey = createHmac('sha256', 'WebAppData').update(token).digest();
const now = () => Math.floor(Date.now() / 1000);
const first = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const current = (id) => first('SELECT * FROM applications WHERE telegram_id = ? ORDER BY id DESC LIMIT 1', id);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function resident(req) {
  const raw = req.headers.authorization?.replace(/^Telegram /, '') ?? '';
  const fields = new URLSearchParams(raw);
  const signature = fields.get('hash') ?? '';
  fields.delete('hash');
  fields.sort();
  const check = [...fields].map(([key, value]) => key + '=' + value).join('\n');
  const expected = createHmac('sha256', telegramKey).update(check).digest('hex');
  const issued = Number(fields.get('auth_date'));
  if (!same(signature, expected) || !Number.isInteger(issued) || issued < now() - 3600 || issued > now() + 60) {
    throw new RequestError(401, 'Откройте приложение заново через Telegram.');
  }
  const user = JSON.parse(fields.get('user') ?? '{}');
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new RequestError(401, 'Вход через Telegram не подтверждён.');
  return {
    id: String(user.id),
    name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 160),
    start: fields.get('start_param'),
  };
}
function admin(req, res) {
  const expected = 'Basic ' + Buffer.from(env.ADMIN_USERNAME + ':' + env.ADMIN_PASSWORD).toString('base64');
  if (!same(req.headers.authorization ?? '', expected)) {
    if (req.method === 'GET' && req.url === '/admin') res.setHeader('WWW-Authenticate', 'Basic realm="Bright Park", charset="UTF-8"');
    throw new RequestError(401, 'Требуется вход администратора.');
  }
}
function plotNumber(value) {
  if (typeof value !== 'string') throw new RequestError(400, 'Укажите номер участка.');
  const number = value.trim().toUpperCase();
  if (!/^[0-9A-ZА-ЯЁ][0-9A-ZА-ЯЁ /-]{0,23}$/.test(number)) throw new RequestError(400, 'Проверьте номер участка.');
  return number;
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'Ожидается JSON.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new RequestError(413, 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError(400, 'Не удалось прочитать запрос.'); }
}
function residentState(user) {
  const item = current(user.id);
  return { name: user.name, status: item?.status ?? 'new', plot: item?.plot ?? item?.requested_plot ?? '',
    note: item?.note ?? '', invite: /^plot_[\w-]{32}$/.test(user.start ?? '') };
}
function checkAvailable(user) {
  if (['pending', 'approved'].includes(current(user.id)?.status)) {
    throw new RequestError(409, 'У вас уже есть заявка на проверке или подтверждённый участок.');
  }
}
function apply(user, body) {
  const plot = plotNumber(body.plot);
  const raw = typeof body.phone === 'string' ? body.phone.trim() : '';
  const phone = raw.replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{10,15}$/.test(phone)) throw new RequestError(400, 'Укажите телефон для связи.');
  checkAvailable(user);
  run(`INSERT INTO applications (telegram_id, name, phone, requested_plot, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`, user.id, user.name, phone, plot, now());
  return residentState(user);
}
function redeem(user) {
  return transaction(() => {
    checkAvailable(user);
    if (!/^plot_[\w-]{32}$/.test(user.start ?? '')) throw new RequestError(400, 'Приглашение не найдено.');
    const digest = hash(user.start);
    const invite = first('SELECT * FROM invites WHERE digest = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', digest, now());
    if (!invite) throw new RequestError(409, 'Приглашение уже использовано, отменено или просрочено.');
    run('UPDATE invites SET used_at = ? WHERE digest = ?', now(), digest);
    run(`INSERT INTO applications (telegram_id, name, phone, requested_plot, plot, status, source, created_at, decided_at)
         VALUES (?, ?, '', ?, ?, 'approved', 'invite', ?, ?)`, user.id, user.name, invite.plot, invite.plot, now(), now());
    return residentState(user);
  });
}
function review(id, body) {
  const status = { approve: 'approved', reject: 'rejected', revoke: 'revoked' }[body.action];
  if (!['approved', 'rejected', 'revoked'].includes(status)) throw new RequestError(400, 'Выберите действие.');
  const expected = status === 'revoked' ? 'approved' : 'pending';
  const plot = status === 'approved' ? plotNumber(body.plot) : null;
  if (plot && !first('SELECT number FROM plots WHERE number = ?', plot)) {
    throw new RequestError(400, 'Выберите участок из реестра.');
  }
  const note = typeof body.note === 'string' && status !== 'approved' ? body.note.trim().slice(0, 500) : '';
  const result = run(`UPDATE applications SET status = ?, plot = COALESCE(?, plot), note = ?, decided_at = ?
    WHERE id = ? AND status = ?`, status, plot, note, now(), id, expected);
  if (!result.changes) throw new RequestError(409, 'Статус уже изменился. Обновите список.');
  return { ok: true };
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org");
  try {
    const route = new URL(req.url, origin).pathname;
    const method = req.method;
    if (route === '/admin' || route.startsWith('/api/admin/')) admin(req, res);
    if (method === 'GET' && Object.hasOwn(assets, route)) {
      const [content, type] = assets[route];
      return res.writeHead(200, { 'Content-Type': type }).end(content);
    }
    if (method === 'GET' && route === '/api/config') return json(res, 200, { botLink });
    if (method === 'POST' && req.headers.origin !== origin.origin) throw new RequestError(403, 'Недопустимый источник запроса.');
    if (route === '/api/resident' && method === 'GET') return json(res, 200, residentState(resident(req)));
    if (route === '/api/resident/application' && method === 'POST') {
      const user = resident(req);
      return json(res, 201, apply(user, await readJson(req)));
    }
    if (route === '/api/resident/invitation' && method === 'POST') {
      const user = resident(req);
      await readJson(req);
      return json(res, 200, redeem(user));
    }
    if (method === 'GET' && route === '/api/admin/state') {
      return json(res, 200, {
        plots: all('SELECT number FROM plots ORDER BY number').map((row) => row.number),
        applications: all("SELECT * FROM applications ORDER BY (status = 'pending') DESC, id DESC"),
        invites: all('SELECT digest, plot, expires_at FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC', now()),
      });
    }
    if (method === 'POST' && route === '/api/admin/plots') {
      const body = await readJson(req);
      if (typeof body.numbers !== 'string') throw new RequestError(400, 'Вставьте номера участков по одному в строке.');
      const numbers = [...new Set(body.numbers.split(/\r?\n/).filter((line) => line.trim()).map(plotNumber))];
      if (!numbers.length || numbers.length > 2000) throw new RequestError(400, 'Добавьте от 1 до 2 000 номеров за раз.');
      transaction(() => numbers.forEach((number) => run('INSERT OR IGNORE INTO plots VALUES (?)', number)));
      return json(res, 201, { ok: true });
    }
    if (method === 'POST' && route === '/api/admin/invites') {
      const plot = plotNumber((await readJson(req)).plot);
      if (!first('SELECT number FROM plots WHERE number = ?', plot)) throw new RequestError(400, 'Выберите участок из реестра.');
      const code = 'plot_' + randomBytes(24).toString('base64url');
      run('INSERT INTO invites (digest, plot, expires_at) VALUES (?, ?, ?)', hash(code), plot, now() + 86400);
      return json(res, 201, { url: botLink + '?startapp=' + code });
    }
    const revocation = route.match(/^\/api\/admin\/invites\/([0-9a-f]{64})$/);
    if (method === 'POST' && revocation) {
      await readJson(req);
      run('UPDATE invites SET revoked_at = ? WHERE digest = ? AND used_at IS NULL', now(), revocation[1]);
      return json(res, 200, { ok: true });
    }
    const decision = route.match(/^\/api\/admin\/applications\/(\d+)$/);
    if (method === 'POST' && decision) return json(res, 200, review(Number(decision[1]), await readJson(req)));
    throw new RequestError(404, 'Страница не найдена.');
  } catch (error) {
    if (!error.status) console.error('Request failed:', error.code ?? error.name);
    json(res, error.status ?? 500, { error: error.status ? error.message : 'Ошибка сервера. Попробуйте позже.' });
  }
}).listen(Number(env.PORT ?? 3000), env.HOST ?? '127.0.0.1');
