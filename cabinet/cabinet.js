const $ = (selector) => document.querySelector(selector);
const feedback = $('#feedback');
const statuses = {
  pending: 'На проверке', approved: 'Участок подтверждён',
  rejected: 'Заявка отклонена', revoked: 'Доступ отозван',
};
const telegram = window.Telegram?.WebApp;
const role = $('main').dataset.role;
async function api(path, body) {
  const headers = {};
  if (role === 'resident' && telegram?.initData) headers.Authorization = 'Telegram ' + telegram.initData;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api' + path, {
    headers, method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Сервер недоступен.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function bind(element, event, action) {
  element.addEventListener(event, async (e) => {
    e.preventDefault();
    const button = e.submitter ?? (element instanceof HTMLButtonElement ? element : null);
    if (button?.disabled) return;
    if (button) button.disabled = true;
    feedback.textContent = '';
    try { await action(); }
    catch (error) { feedback.textContent = error.message; }
    finally { if (button) button.disabled = false; }
  });
}
function text(tag, value) {
  const el = document.createElement(tag);
  el.textContent = value;
  return el;
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
function refreshResident() {
  return api('/resident').then(renderResident);
}
function renderResident(state) {
  $('#resident-name').textContent = state.name;
  $('#state-title').textContent = statuses[state.status] ?? 'Привяжите участок';
  let detail = state.plot ? 'Участок ' + state.plot + '.' : 'Укажите участок и телефон. УК сверит заявку с реестром.';
  if (state.status === 'pending') detail += ' УК проверяет заявку. Статус появится здесь.';
  if (state.note) detail += ' ' + state.note;
  $('#state-detail').textContent = detail;
  const canApply = !['pending', 'approved'].includes(state.status);
  $('#redeem').hidden = !(canApply && state.invite);
  $('#show-request').hidden = !(canApply && state.invite);
  $('#apply').hidden = !canApply || state.invite;
  $('#refresh').hidden = state.status !== 'pending';
}
async function startResident() {
  if (!telegram?.initData) {
    const { botLink } = await api('/config');
    $('#state-title').textContent = 'Вход через Telegram';
    $('#state-detail').textContent = 'Откройте Брайт Парк в Telegram, чтобы привязать участок и проверить статус заявки.';
    $('#open-telegram').href = botLink + '?startapp';
    $('#open-telegram').hidden = false;
    return;
  }
  telegram.ready();
  bind($('#refresh'), 'click', refreshResident);
  bind($('#show-request'), 'click', () => { $('#apply').hidden = false; });
  bind($('#redeem'), 'click', async () => renderResident(await api('/resident/invitation', {})));
  bind($('#apply'), 'submit', async () => {
    renderResident(await api('/resident/application', formData($('#apply'))));
    $('#apply').reset();
  });
  await refreshResident();
}
function plotOptions(select, plots, selected) {
  select.replaceChildren(new Option('Выберите участок', ''));
  for (const plot of plots) select.add(new Option(plot, plot, false, plot === selected));
}
function applicationCard(item, plots) {
  const card = document.createElement('article');
  card.className = 'card';
  card.append(text('h2', item.name || 'Житель Telegram'),
    text('p', statuses[item.status] + ' · участок ' + (item.plot ?? item.requested_plot)));
  const contact = item.phone ? 'Телефон из заявки: ' + item.phone : 'Подключение по приглашению УК';
  card.append(text('p', contact + ' · Telegram ID ' + item.telegram_id));
  if (item.note) card.append(text('p', item.note));
  if (!['pending', 'approved'].includes(item.status)) return card;
  const form = document.createElement('form');
  const pending = item.status === 'pending';
  const select = document.createElement('select');
  if (pending) {
    select.setAttribute('aria-label', 'Участок для привязки');
    plotOptions(select, plots, item.requested_plot);
    form.append(select);
  }
  const note = document.createElement('input');
  note.placeholder = 'Причина для жителя (необязательно)';
  note.setAttribute('aria-label', note.placeholder);
  note.maxLength = 500;
  form.append(note);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const choices = pending ? { approve: 'Подтвердить', reject: 'Отклонить' } : { revoke: 'Отозвать доступ' };
  for (const [action, label] of Object.entries(choices)) {
    const button = text('button', label);
    button.type = 'button';
    button.className = action === 'approve' ? '' : 'secondary';
    bind(button, 'click', async () => {
      if (action === 'approve' && !select.value) throw new Error('Выберите участок из реестра.');
      if (action === 'revoke' && !window.confirm('Отозвать доступ для этого жителя?')) return;
      await api('/admin/applications/' + item.id, { action, plot: select.value, note: note.value });
      await refreshAdmin();
    });
    actions.append(button);
  }
  form.addEventListener('submit', (event) => event.preventDefault());
  form.append(actions);
  card.append(form);
  return card;
}
async function refreshAdmin() {
  const { plots, applications, invites } = await api('/admin/state');
  $('#plot-count').textContent = 'Участков в реестре: ' + plots.length;
  const select = $('#new-invite select');
  plotOptions(select, plots, select.value);
  $('#new-invite button').disabled = !plots.length;
  $('#applications').replaceChildren(...(applications.length ?
    applications.map((item) => applicationCard(item, plots)) : [text('p', 'Заявок пока нет.')]));
  $('#invites').replaceChildren(...invites.map((invite) => {
    const row = document.createElement('div');
    row.className = 'invite-row';
    const expires = new Date(invite.expires_at * 1000).toLocaleString('ru-RU');
    const button = text('button', 'Отменить ссылку');
    button.className = 'secondary';
    button.type = 'button';
    bind(button, 'click', async () => {
      await api('/admin/invites/' + invite.digest, {});
      $('#invite-result').hidden = true;
      $('#invite-link').value = '';
      await refreshAdmin();
    });
    row.append(text('span', 'Участок ' + invite.plot + ' · до ' + expires), button);
    return row;
  }));
}
async function startAdmin() {
  bind($('#refresh'), 'click', refreshAdmin);
  bind($('#plots'), 'submit', async () => {
    await api('/admin/plots', formData($('#plots')));
    $('#plots').reset();
    await refreshAdmin();
  });
  bind($('#new-invite'), 'submit', async () => {
    const { url } = await api('/admin/invites', formData($('#new-invite')));
    $('#invite-link').value = url;
    $('#invite-result').hidden = false;
    await refreshAdmin();
  });
  bind($('#copy-link'), 'click', async () => {
    await navigator.clipboard.writeText($('#invite-link').value);
    feedback.textContent = 'Ссылка скопирована.';
  });
  await refreshAdmin();
}
(role === 'resident' ? startResident() : startAdmin()).catch((error) => {
  if (role === 'resident') $('#state-title').textContent = 'Не удалось открыть кабинет';
  feedback.textContent = error.message;
});
