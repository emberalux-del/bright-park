(() => {
  const query = (selector) => document.querySelector(selector);
  const status = query('#phone-feedback');

  async function request(path, options) {
    const response = await fetch('/api' + path, options);
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function post(path, data = {}) {
    return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }
  function on(selector, event, action) {
    query(selector).addEventListener(event, async (e) => {
      e.preventDefault();
      const button = e.submitter ?? (e.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null);
      if (button) button.disabled = true;
      status.textContent = '';
      try { await action(e.currentTarget); }
      catch (error) { status.textContent = error.message; }
      finally { if (button) button.disabled = false; }
    });
  }
  const fields = (form) => Object.fromEntries(new FormData(form));
  async function showProfile() {
    const info = await request('/phone/me');
    query('#phone-title').textContent = 'Мой участок';
    query('#phone-plot').textContent = 'Участок ' + info.plot;
    query('#phone-number').textContent = info.phone;
    query('#phone-profile').hidden = false;
    query('#password-login').hidden = true;
    query('#phone-activation').hidden = true;
    query('#show-activation').hidden = true;
    query('#telegram-options').hidden = true;
  }
  function showLogin() {
    query('#phone-title').textContent = 'Вход по телефону';
    query('#phone-profile').hidden = true;
    query('#password-login').hidden = false;
    query('#phone-activation').hidden = true;
    query('#show-activation').hidden = false;
    query('#telegram-options').hidden = false;
  }
  async function showRegistry() {
    const { entries } = await request('/admin/registry');
    query('#registry-count').textContent = 'Активные записи: ' + entries.length;
    query('#registry-entries').replaceChildren(...entries.map(({ phone, plot }) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = 'Отключить';
      button.addEventListener('click', async () => {
        if (!confirm('Отключить вход для +' + phone + ' на участке ' + plot + '?')) return;
        button.disabled = true;
        try {
          await post('/admin/registry/disable', { phone });
          await showRegistry();
          status.textContent = 'Доступ по телефону отключён.';
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        }
      });
      item.append('Участок ' + plot + ' · +' + phone, button);
      return item;
    }));
  }
  if (query('#registry-upload')) {
    on('#registry-upload', 'submit', async (form) => {
      const file = form.elements.registry.files[0];
      if (!file || file.size > 2_000_000) throw new Error('Выберите файл размером до 2 МБ.');
      const format = file.name.toLowerCase().match(/\.(xlsx|csv)$/)?.[0];
      if (!format) throw new Error('Выберите файл XLSX или CSV.');
      const result = await request('/admin/registry', { method: 'POST', headers: { 'X-Registry-Format': format }, body: file });
      form.reset();
      await showRegistry();
      query('#refresh').click();
      status.textContent = 'Подключено: ' + result.added + '. Уже в реестре: ' + result.unchanged + '.';
    });
    showRegistry().catch((error) => { status.textContent = error.message; });
    return;
  }

  const start = new URLSearchParams(window.Telegram?.WebApp?.initData ?? '').get('start_param');
  if (start?.startsWith('plot_')) query('#telegram-options').open = true;
  on('#password-login', 'submit', async (form) => {
    await post('/phone/login', fields(form));
    form.reset();
    await showProfile();
  });
  on('#show-activation', 'click', () => {
    const input = query('#phone-activation input[name="phone"]');
    input.value = query('#password-login input[name="phone"]').value;
    query('#phone-title').textContent = 'Подтверждение телефона';
    query('#phone-activation').hidden = false;
    query('#password-login').hidden = true;
    query('#show-activation').hidden = true;
    input.focus();
  });
  on('#show-login', 'click', showLogin);
  on('#request-code', 'click', async () => {
    const input = query('#phone-activation input[name="phone"]');
    if (!input.reportValidity()) return;
    const result = await post('/phone/code', { phone: input.value });
    status.textContent = result.message;
    query('#phone-activation input[name="code"]').focus();
  });
  on('#phone-activation', 'submit', async (form) => {
    await post('/phone/activate', fields(form));
    form.reset();
    await showProfile();
  });
  on('#password-change', 'submit', async (form) => {
    await post('/phone/password', fields(form));
    form.reset();
    status.textContent = 'Пароль изменён.';
  });
  on('#phone-logout', 'click', async () => {
    await post('/phone/logout');
    showLogin();
  });
  showProfile().catch((error) => {
    if (error.status !== 401) status.textContent = error.message;
  });
})();
