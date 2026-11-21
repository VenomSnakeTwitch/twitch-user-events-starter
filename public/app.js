const byId = (id) => document.getElementById(id);
const state = { config: null, me: null, toastTimer: null };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function currencyNode(amount, withName = false) {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(new Intl.NumberFormat('de-DE').format(amount) + ' '));
  if (state.config?.currencyImage) {
    const image = node('img', 'currency-image');
    image.src = `/waehrung/${encodeURIComponent(state.config.currencyImage)}`;
    image.alt = state.config.currencyName;
    fragment.append(image, document.createTextNode(' '));
  } else {
    fragment.append(document.createTextNode(`${state.config?.currencyEmoji || '✦'} `));
  }
  if (withName) fragment.append(document.createTextNode(state.config?.currencyName || 'Währung'));
  return fragment;
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* Setup page or empty response. */ }
  if (!response.ok) {
    const error = new Error(payload.error || 'request_failed');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function updateLive(isLive) {
  const pill = document.querySelector('.live-pill');
  pill.classList.toggle('is-live', Boolean(isLive));
  byId('live-label').textContent = isLive ? 'Stream ist live' : 'Stream gerade offline';
}

function renderConfig(config) {
  state.config = config;
  const name = config.hubName || 'Zuschauer-Hub';
  document.title = name;
  byId('hub-name').textContent = name;
  byId('footer-hub-name').textContent = name;
  byId('currency-hero').textContent = config.currencyName || 'Community-Währung';
  byId('currency-name').textContent = config.currencyName || 'Währung';
  byId('currency-icon').textContent = config.currencyEmoji || '✦';
  if (config.currencyImage) {
    const image = node('img', 'currency-image');
    image.src = `/waehrung/${encodeURIComponent(config.currencyImage)}`;
    image.alt = config.currencyName || 'Währung';
    byId('currency-icon').replaceChildren(image);
  }
  updateLive(config.isLive);
  renderActions(config.actions || []);
  updateBalance();
}

function updateBalance() {
  const me = state.me;
  const cfg = state.config;
  if (me) {
    const balance = byId('balance-value');
    balance.replaceChildren(node('strong', '', new Intl.NumberFormat('de-DE').format(me.bananas || 0)));
    if (cfg?.currencyImage) {
      const image = node('img', 'currency-image');
      image.src = `/waehrung/${encodeURIComponent(cfg.currencyImage)}`;
      image.alt = cfg.currencyName || 'Währung';
      balance.append(image);
    } else {
      balance.append(node('span', '', cfg?.currencyEmoji || '✦'));
    }
    balance.append(node('span', '', cfg?.currencyName || 'Währung'));
    byId('welcome-name').textContent = `Hallo, ${me.displayName || me.login || 'Streamer'}!`;
    byId('watch-hint').textContent = me.isAdmin
      ? 'Als Streamer sammelst du im eigenen Kanal keine Zuschau-Währung.'
      : 'Deine Zeit im Stream zahlt sich aus.';
    byId('login-link').classList.add('hidden');
    byId('logout-button').classList.remove('hidden');
    byId('delete-account-button').classList.remove('hidden');
    byId('delete-confirm').classList.add('hidden');
    byId('admin-link').classList.toggle('hidden', !me.isAdmin);
    const interval = Math.max(1, cfg?.watchIntervalMinutes || 10);
    const minutes = me.watchMinutes || 0;
    const remainder = minutes % interval;
    const left = remainder ? interval - remainder : interval;
    const progress = Math.min(100, (remainder / interval) * 100);
    byId('progress-fill').style.width = `${progress}%`;
    byId('progress-label').textContent = `${remainder}/${interval} Min.`;
    byId('progress-caption').textContent = me.isAdmin
      ? 'Im eigenen Kanal gibt es keine Zuschau-Währung.'
      : cfg?.watchBananas > 0
        ? `Noch ${left} ${left === 1 ? 'Minute' : 'Minuten'} im Twitch-Chat bis ${cfg.watchBananas} ${cfg.currencyEmoji || ''} ${cfg.currencyName || 'Währung'}.`
        : 'Zuschau-Belohnungen sind gerade pausiert.';
    const checkin = byId('checkin-button');
    const checkedIn = Boolean(me.checkedInToday);
    checkin.disabled = checkedIn || !me.isLive;
    byId('checkin-label').textContent = checkedIn ? 'Für heute erledigt ✓' : `Täglichen Check-in holen · +${cfg?.checkinBananas || 0}`;
    byId('account-message').textContent = checkedIn
      ? 'Schön, dass du heute schon vorbeigeschaut hast.'
      : me.isLive ? 'Der tägliche Bonus wartet auf dich.' : 'Der Check-in ist verfügbar, wenn der Stream live ist.';
  } else {
    byId('balance-value').textContent = '—';
    byId('welcome-name').textContent = 'Hallo, Zuschauer:in!';
    byId('watch-hint').textContent = 'Melde dich an, um deinen Fortschritt zu sehen.';
    byId('login-link').classList.remove('hidden');
    byId('logout-button').classList.add('hidden');
    byId('delete-account-button').classList.add('hidden');
    byId('delete-confirm').classList.add('hidden');
    byId('admin-link').classList.add('hidden');
  }
}

function renderActions(actions) {
  if (!actions.length) return;
  const list = byId('action-list');
  list.replaceChildren();
  byId('action-count').textContent = `${actions.length} COMMUNITY-AKTIONEN`;
  const styles = { sound: ['♫', 'SOUND', 'action-purple'], rain: ['✺', 'WÄHRUNGSREGEN', 'action-gold'], vote: ['☷', 'COMMUNITY-VOTE', 'action-blue'], confetti: ['🎉', 'KONFETTI', 'action-gold'], message: ['📣', 'OVERLAY-NACHRICHT', 'action-blue'], spotlight: ['✦', 'SPOTLIGHT', 'action-purple'], jumpscare: ['☠', 'JUMPSCARE', 'action-red'] };
  for (const action of actions) {
    const [icon, tag, color] = styles[action.type] || styles.sound;
    const card = node('article', `action-card ${color}`);
    card.append(node('div', 'action-icon', icon));
    const body = node('div', 'action-body');
    body.append(node('span', 'action-tag', tag), node('h3', '', action.name), node('p', '', action.description || 'Eine Aktion für den gemeinsamen Stream-Moment.'));
    card.append(body);
    let option;
    let spotlightName;
    if (action.type === 'vote' && action.options?.length) {
      const wrap = node('div', 'action-extra');
      option = node('select');
      option.setAttribute('aria-label', `Option für ${action.name}`);
      for (const value of action.options) option.append(new Option(value, value));
      wrap.append(option);
      card.append(wrap);
    }
    if (action.type === 'spotlight') {
      const wrap = node('label', 'action-extra spotlight-input');
      wrap.append(node('span', '', 'Twitch-Kanalname für das Spotlight'));
      spotlightName = node('input');
      spotlightName.type = 'text';
      spotlightName.maxLength = 25;
      spotlightName.autocomplete = 'off';
      spotlightName.placeholder = 'z. B. VenomSnake_Twitch';
      spotlightName.required = true;
      wrap.append(spotlightName, node('small', '', 'Der Link zum eingegebenen Twitch-Kanal erscheint im Overlay.'));
      card.append(wrap);
    }
    const footer = node('div', 'action-footer');
    const price = node('span', 'price');
    price.append(currencyNode(action.cost));
    const button = node('button', 'button button-card', state.me ? 'Einlösen' : 'Anmelden');
    button.type = 'button';
    button.disabled = !state.me;
    button.addEventListener('click', () => redeem(action, option?.value, spotlightName?.value));
    footer.append(price, button);
    card.append(footer);
    list.append(card);
  }
}

async function redeem(action, option, enteredChannel) {
  const spotlightName = enteredChannel?.trim();
  if (action.type === 'spotlight' && !spotlightName) {
    showToast('Bitte gib den Twitch-Kanalnamen ein.');
    return;
  }
  try {
    const result = await request('/api/redeem', { method: 'POST', body: JSON.stringify({ actionId: action.id, ...(option ? { option } : {}), ...(action.type === 'spotlight' ? { spotlightName } : {}) }) });
    state.me.bananas = result.bananas;
    updateBalance();
    showToast(`${action.name} wurde ausgelöst!`);
  } catch (error) {
    const messages = { not_enough_bananas: 'Dafür reicht dein aktueller Kontostand noch nicht.', cooldown: 'Diese Aktion ist gleich wieder verfügbar.', not_live: 'Die Aktion ist verfügbar, wenn der Stream live ist.', invalid_option: 'Bitte wähle eine gültige Option.', invalid_spotlight_name: 'Bitte gib einen gültigen Twitch-Kanalnamen ein (Buchstaben, Zahlen, Unterstrich; höchstens 25 Zeichen).' };
    showToast(messages[error.message] || 'Die Aktion konnte gerade nicht ausgelöst werden.');
  }
}

async function loadMe() {
  try {
    state.me = await request('/api/me');
    updateLive(state.me.isLive);
    updateBalance();
    if (state.config) renderActions(state.config.actions || []);
  } catch (error) {
    if (error.status === 401) {
      state.me = null;
      updateBalance();
      if (state.config) renderActions(state.config.actions || []);
    }
  }
}

async function loadLeaderboard() {
  try {
    const data = await request('/api/leaderboard');
    const list = byId('leader-list');
    list.replaceChildren();
    if (!data.entries?.length) {
      list.append(node('li', 'empty-rank', 'Noch keine Einträge. Sei bei den Ersten dabei!'));
      return;
    }
    data.entries.forEach((entry, index) => {
      const row = node('li', `rank-${index + 1}`);
      row.append(node('span', 'rank-number', String(index + 1)), node('span', 'rank-name', entry.displayName));
      const score = node('span', 'rank-score');
      score.append(currencyNode(entry.bananas));
      row.append(score);
      list.append(row);
    });
    byId('leader-status').textContent = 'Jede Aktion bringt dich weiter.';
  } catch { /* Leaderboard is unavailable until the hub is configured. */ }
}

byId('checkin-button').addEventListener('click', async () => {
  try {
    const result = await request('/api/checkin', { method: 'POST', body: '{}' });
    state.me.bananas = result.bananas;
    state.me.checkedInToday = true;
    updateBalance();
    showToast(`Check-in erledigt · +${state.config?.checkinBananas || 0} ${state.config?.currencyEmoji || ''}`);
  } catch (error) {
    const messages = { already_checked_in: 'Dein Check-in ist für heute schon erledigt.', not_live: 'Der Check-in ist verfügbar, wenn der Stream live ist.' };
    showToast(messages[error.message] || 'Der Check-in konnte gerade nicht gespeichert werden.');
  }
});

byId('logout-button').addEventListener('click', async () => {
  try {
    await request('/auth/logout', { method: 'POST', body: '{}' });
    state.me = null;
    updateBalance();
    if (state.config) renderActions(state.config.actions || []);
    showToast('Du wurdest abgemeldet.');
  } catch { showToast('Abmelden ist gerade nicht möglich.'); }
});

byId('delete-account-button').addEventListener('click', () => byId('delete-confirm').classList.remove('hidden'));
byId('delete-cancel-button').addEventListener('click', () => byId('delete-confirm').classList.add('hidden'));
byId('delete-confirm-button').addEventListener('click', async () => {
  try {
    await request('/api/me/delete', { method: 'POST', body: '{}' });
    state.me = null;
    updateBalance();
    if (state.config) renderActions(state.config.actions || []);
    showToast('Dein Konto und die gespeicherten Daten wurden gelöscht.');
  } catch { showToast('Das Konto konnte gerade nicht gelöscht werden.'); }
});

async function initialize() {
  try {
    const config = await request('/api/config');
    renderConfig(config);
    await Promise.all([loadMe(), loadLeaderboard()]);
  } catch {
    byId('setup-banner').classList.remove('hidden');
    updateLive(false);
  }
}

initialize();
setInterval(() => { if (!document.hidden) loadMe(); }, 15000);
setInterval(() => { if (!document.hidden) loadLeaderboard(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadMe(); loadLeaderboard(); } });
