import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const sessionLifetime = 60 * 60 * 24 * 14;
const otpLifetime = 300;
const otpResponse = { message: 'Если номер есть в реестре УК, на него придёт код.' };

export function phoneRoutes({ db, origin, first, run, all, now, transaction, hash, same, plotNumber, readJson, json, RequestError }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_registry (
      phone TEXT PRIMARY KEY, plot TEXT NOT NULL REFERENCES plots(number), active INTEGER NOT NULL DEFAULT 1,
      password TEXT, attempted_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS phone_codes (
      phone TEXT PRIMARY KEY REFERENCES phone_registry(phone), digest TEXT, issued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL, window_start INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phone_sessions (
      digest TEXT PRIMARY KEY, phone TEXT NOT NULL REFERENCES phone_registry(phone), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phone_limits (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL);
  `);
  const smsKey = process.env.SMS_RU_API_ID;
  const otpKey = process.env.OTP_SECRET;
  if (smsKey && (otpKey?.length ?? 0) < 32) throw new Error('Set OTP_SECRET to a random secret of at least 32 characters.');

  function normalizePhone(value) {
    const digits = typeof value === 'string' ? value.trim().replace(/[+\s()-]/g, '') : '';
    const national = digits.length === 10 ? digits : /^[78]\d{10}$/.test(digits) ? digits.slice(1) : '';
    if (!/^\d{10}$/.test(national)) throw new RequestError(400, 'Укажите телефон в формате +7 XXX XXX XX XX.');
    return '7' + national;
  }
  function checkPassword(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
      throw new RequestError(400, 'Пароль должен содержать от 12 до 128 символов.');
    }
    return value;
  }
  async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
    const digest = await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
    return salt + ':' + digest.toString('hex');
  }
  function consumeLimit(key, limit, window) {
    const time = now();
    const current = first('SELECT * FROM phone_limits WHERE key = ?', key);
    if (!current || current.started_at <= time - window) {
      run('INSERT OR REPLACE INTO phone_limits VALUES (?, ?, 1)', key, time);
      return true;
    }
    if (current.count >= limit) return false;
    run('UPDATE phone_limits SET count = count + 1 WHERE key = ?', key);
    return true;
  }
  const account = (phone) => first('SELECT * FROM phone_registry WHERE phone = ? AND active = 1', phone);
  const signCode = (phone, code) => createHmac('sha256', otpKey).update(phone + ':' + code).digest('hex');

  async function sendSms(phone, code) {
    const fields = new URLSearchParams({ api_id: smsKey, to: phone, msg: 'Брайт Парк. Код: ' + code, json: '1' });
    if (process.env.SMS_RU_SENDER) fields.set('from', process.env.SMS_RU_SENDER);
    const response = await fetch('https://sms.ru/sms/send?' + fields, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    const result = await response.json();
    if (!response.ok || result.status_code !== 100 || result.sms?.[phone]?.status_code !== 100) {
      throw new Error('SMS provider rejected the request');
    }
  }
  function issueCode(phone) {
    if (!smsKey) throw new RequestError(503, 'Отправка SMS пока не подключена. Обратитесь в УК.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const digest = signCode(phone, code);
    const scheduled = transaction(() => {
      if (!account(phone)) return false;
      const previous = first('SELECT * FROM phone_codes WHERE phone = ?', phone);
      const time = now();
      if (previous && previous.issued_at > time - 60) return false;
      const sameWindow = previous && previous.window_start > time - 3600;
      if ((sameWindow && previous.sent_count >= 4) || !consumeLimit('sms-global', 100, 3600)) return false;
      run('INSERT OR REPLACE INTO phone_codes VALUES (?, ?, ?, 0, ?, ?)',
        phone, digest, time, sameWindow ? previous.sent_count + 1 : 1, sameWindow ? previous.window_start : time);
      return true;
    });
    if (scheduled) void sendSms(phone, code).catch(() => {
      run('UPDATE phone_codes SET digest = NULL WHERE phone = ? AND digest = ?', phone, digest);
      console.error('SMS delivery request failed');
    });
    return otpResponse;
  }
  function cookie(res, value, seconds) {
    const secure = origin.protocol === 'https:' ? 'Secure; ' : '';
    res.setHeader('Set-Cookie', `bp_session=${value}; Path=/; Max-Age=${seconds}; ${secure}HttpOnly; SameSite=Lax`);
  }
  function sessionKey(req) {
    const value = req.headers.cookie?.match(/(?:^|;\s*)bp_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    return value ? hash(value) : null;
  }
  function authenticated(req) {
    const digest = sessionKey(req);
    const session = digest && first(`SELECT r.* FROM phone_sessions s JOIN phone_registry r USING(phone)
      WHERE s.digest = ? AND s.expires_at > ? AND r.active = 1`, digest, now());
    if (!session) throw new RequestError(401, 'Войдите в личный кабинет.');
    return session;
  }
  function startSession(res, phone, previous) {
    const token = randomBytes(32).toString('hex');
    if (previous) run('DELETE FROM phone_sessions WHERE digest = ?', previous);
    run('DELETE FROM phone_sessions WHERE expires_at <= ?', now());
    run('INSERT INTO phone_sessions VALUES (?, ?, ?)', hash(token), phone, now() + sessionLifetime);
    cookie(res, token, sessionLifetime);
  }
  async function activate(req, res, body) {
    if (!smsKey) throw new RequestError(503, 'Отправка SMS пока не подключена. Обратитесь в УК.');
    const phone = normalizePhone(body.phone);
    const password = checkPassword(body.password);
    const code = typeof body.code === 'string' ? body.code : '';
    if (!/^\d{6}$/.test(code)) throw new RequestError(400, 'Введите шестизначный код из SMS.');
    const signed = signCode(phone, code);
    const claim = randomBytes(32).toString('hex');
    const accepted = transaction(() => {
      const current = first('SELECT * FROM phone_codes WHERE phone = ?', phone);
      if (!current?.digest || current.issued_at <= now() - otpLifetime || current.attempts >= 5 || !account(phone)) return false;
      run('UPDATE phone_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
      if (!same(signed, current.digest)) return false;
      run('UPDATE phone_codes SET digest = ?, attempts = 5 WHERE phone = ?', claim, phone);
      return true;
    });
    if (!accepted) throw new RequestError(400, 'Код не подходит или истёк. Запросите новый код.');
    const stored = await passwordHash(password);
    transaction(() => {
      const row = account(phone);
      const current = first('SELECT digest FROM phone_codes WHERE phone = ?', phone);
      if (!row || current?.digest !== claim) throw new RequestError(409, 'Запросите новый код.');
      run('UPDATE phone_codes SET digest = NULL WHERE phone = ?', phone);
      run('UPDATE phone_registry SET password = ?, failures = 0 WHERE phone = ?', stored, phone);
      run('DELETE FROM phone_sessions WHERE phone = ?', phone);
      startSession(res, phone, sessionKey(req));
    });
    return { ok: true };
  }
  async function login(req, res, body) {
    const phone = normalizePhone(body.phone);
    const password = checkPassword(body.password);
    if (!consumeLimit('password-global', 120, 60)) throw new RequestError(429, 'Слишком много попыток. Попробуйте позже.');
    const row = account(phone);
    const time = now();
    if (row?.failures >= 8 && row.attempted_at > time - 900) {
      throw new RequestError(429, 'Слишком много попыток. Попробуйте через 15 минут или восстановите пароль.');
    }
    if (row) run('UPDATE phone_registry SET attempted_at = ?, failures = ? WHERE phone = ?',
      time, (row.attempted_at > time - 900 ? row.failures : 0) + 1, phone);
    const salt = row?.password?.split(':')[0] ?? '00000000000000000000000000000000';
    const verified = await passwordHash(password, salt);
    if (!row?.password || !same(verified, row.password) || account(phone)?.password !== row.password) {
      throw new RequestError(401, 'Неверный телефон или пароль.');
    }
    run('UPDATE phone_registry SET failures = 0 WHERE phone = ?', phone);
    startSession(res, phone, sessionKey(req));
    return { ok: true };
  }
  async function changePassword(req, res, body) {
    const row = authenticated(req);
    const old = checkPassword(body.current);
    const next = checkPassword(body.password);
    const [verified, stored] = await Promise.all([passwordHash(old, row.password.split(':')[0]), passwordHash(next)]);
    if (!same(verified, row.password)) throw new RequestError(400, 'Текущий пароль не подходит.');
    transaction(() => {
      if (authenticated(req).password !== row.password) throw new RequestError(409, 'Пароль уже изменился.');
      run('UPDATE phone_registry SET password = ?, failures = 0 WHERE phone = ?', stored, row.phone);
      run('UPDATE phone_codes SET digest = NULL, attempts = 5 WHERE phone = ?', row.phone);
      run('DELETE FROM phone_sessions WHERE phone = ?', row.phone);
      startSession(res, row.phone);
    });
    return { ok: true };
  }

  async function fileRows(req) {
    const extension = req.headers['x-registry-format'];
    if (!['.xlsx', '.csv'].includes(extension)) throw new RequestError(400, 'Выберите файл XLSX или CSV.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_000_000) throw new RequestError(413, 'Файл должен быть меньше 2 МБ.');
      chunks.push(chunk);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON_BIN ?? 'python3', [fileURLToPath(new URL('registry.py', import.meta.url)), extension],
        { stdio: ['pipe', 'pipe', 'ignore'], timeout: 7000 });
      const result = [];
      child.stdout.on('data', (part) => result.push(part));
      child.stdin.on('error', () => {});
      child.on('error', () => reject(new RequestError(503, 'Служба импорта недоступна.')));
      child.on('close', (status) => {
        try {
          if (status !== 0) throw new Error();
          resolve(JSON.parse(Buffer.concat(result).toString()));
        } catch { reject(new RequestError(400, 'Проверьте заголовки «Телефон» и «Участок», формат файла и лимит в 2 000 строк.')); }
      });
      child.stdin.end(Buffer.concat(chunks));
    });
  }
  async function importRegistry(req) {
    const rows = await fileRows(req);
    const entries = new Map();
    for (const [line, phoneValue, plotValue] of rows) {
      let phone, plot;
      try { phone = normalizePhone(phoneValue); plot = plotNumber(plotValue); }
      catch (error) { throw new RequestError(400, 'Строка ' + line + '. ' + error.message); }
      if (entries.has(phone) && entries.get(phone).plot !== plot) {
        throw new RequestError(409, 'Строка ' + line + '. Один телефон указан для разных участков.');
      }
      entries.set(phone, { plot, line });
    }
    if (!entries.size) throw new RequestError(400, 'В файле нет записей.');
    return transaction(() => {
      let added = 0;
      for (const [phone, { plot, line }] of entries) {
        const old = first('SELECT plot, active FROM phone_registry WHERE phone = ?', phone);
        if (old?.active && old.plot !== plot) {
          throw new RequestError(409, 'Строка ' + line + '. Телефон уже привязан к другому участку. Сначала отключите старую запись.');
        }
        if (old?.active) continue;
        run('INSERT OR IGNORE INTO plots VALUES (?)', plot);
        run(`INSERT INTO phone_registry(phone, plot) VALUES (?, ?) ON CONFLICT(phone)
          DO UPDATE SET plot = excluded.plot, active = 1, password = NULL, attempted_at = 0, failures = 0`, phone, plot);
        added++;
      }
      return { added, unchanged: entries.size - added };
    });
  }
  function disable(phone) {
    return transaction(() => {
      run('UPDATE phone_registry SET active = 0, password = NULL WHERE phone = ?', phone);
      run('DELETE FROM phone_codes WHERE phone = ?', phone);
      run('DELETE FROM phone_sessions WHERE phone = ?', phone);
      return { ok: true };
    });
  }
  return async (req, res, route) => {
    if (req.method === 'GET' && route === '/api/phone/me') {
      const row = authenticated(req);
      json(res, 200, { phone: '+' + row.phone, plot: row.plot });
      return true;
    }
    if (req.method === 'GET' && route === '/api/admin/registry') {
      json(res, 200, { entries: all('SELECT phone, plot FROM phone_registry WHERE active = 1 ORDER BY plot, phone') });
      return true;
    }
    if (req.method !== 'POST') return false;
    if (route === '/api/admin/registry') {
      json(res, 201, await importRegistry(req));
      return true;
    }
    const actions = {
      '/api/phone/code': (body) => issueCode(normalizePhone(body.phone)),
      '/api/phone/activate': (body) => activate(req, res, body),
      '/api/phone/login': (body) => login(req, res, body),
      '/api/phone/password': (body) => changePassword(req, res, body),
      '/api/phone/logout': () => {
        run('DELETE FROM phone_sessions WHERE digest = ?', sessionKey(req));
        cookie(res, '', 0);
        return { ok: true };
      },
      '/api/admin/registry/disable': (body) => disable(normalizePhone(body.phone)),
    };
    if (!Object.hasOwn(actions, route)) return false;
    json(res, 200, await actions[route](await readJson(req)));
    return true;
  };
}
