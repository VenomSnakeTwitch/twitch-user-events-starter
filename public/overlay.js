const query = new URLSearchParams(location.search);
const key = query.get('key');
const root = document.getElementById('events');
let config;
let voteTimer;

function addMessage(name, message, className = '') {
  const item = document.createElement('div');
  item.className = `event ${className}`;
  const strong = document.createElement('strong');
  strong.textContent = name;
  item.append(strong, document.createTextNode(` ${message}`));
  root.prepend(item);
  while (root.children.length > 4) root.lastElementChild.remove();
  setTimeout(() => { item.classList.add('fade'); setTimeout(() => item.remove(), 450); }, 8500);
}

function currencyIcon(className = 'coin-icon') {
  if (config?.currencyImage) {
    const image = document.createElement('img');
    image.className = className;
    image.src = `/waehrung/${encodeURIComponent(config.currencyImage)}`;
    image.alt = config.currencyName || 'Währung';
    return image;
  }
  const icon = document.createElement('span');
  icon.className = className;
  icon.textContent = config?.currencyEmoji || '✦';
  return icon;
}

function rain(count = 26) {
  const layer = document.createElement('div');
  layer.className = 'rain-layer';
  for (let index = 0; index < count; index += 1) {
    const item = currencyIcon('rain-coin');
    item.style.left = `${Math.random() * 100}%`;
    item.style.animationDelay = `${Math.random() * 1.5}s`;
    item.style.animationDuration = `${2.2 + Math.random() * 2}s`;
    layer.append(item);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 5000);
}

function confetti(count = 70) {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  const colors = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ffffff'];
  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.setProperty('--confetti-color', colors[index % colors.length]);
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    piece.style.animationDuration = `${2.4 + Math.random() * 1.8}s`;
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 5000);
}

function showSpotlight(name, actionName) {
  const layer = document.createElement('div');
  layer.className = 'spotlight-layer';
  const card = document.createElement('div');
  card.className = 'spotlight-card';
  const title = document.createElement('strong');
  title.textContent = actionName;
  const viewer = document.createElement('span');
  viewer.textContent = `Ausgelöst von ${name}`;
  card.append(title, viewer);
  layer.append(card);
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3200);
}

function jumpScare() {
  const layer = document.createElement('div');
  layer.className = 'jumpscare-layer';
  const face = document.createElement('div');
  face.className = 'jumpscare-face';
  face.textContent = '👹';
  const text = document.createElement('strong');
  text.textContent = 'BÖÖ!';
  layer.append(face, text);
  document.body.append(layer);
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(260, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(75, audio.currentTime + 0.32);
    gain.gain.setValueAtTime(0.14, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.38);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.4);
    oscillator.addEventListener('ended', () => audio.close(), { once: true });
  } catch { /* Audio output can be unavailable in the browser source. */ }
  setTimeout(() => layer.remove(), 1150);
}

function sound(file) {
  if (file) {
    const audio = new Audio(`/sounds/${encodeURIComponent(file)}`);
    audio.volume = 0.8;
    audio.play().catch(() => {});
    return;
  }
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(440, audio.currentTime + 0.12);
    gain.gain.setValueAtTime(0.12, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.16);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.17);
    oscillator.addEventListener('ended', () => audio.close(), { once: true });
  } catch { /* Audio output can be unavailable in the browser source. */ }
}

function showVotes(event) {
  let panel = document.getElementById('vote-panel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'vote-panel';
    panel.className = 'vote-panel';
    panel.setAttribute('aria-live', 'polite');
    document.body.append(panel);
  }
  panel.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = 'Community-Abstimmung';
  panel.append(title);
  const total = event.options.reduce((sum, item) => sum + item.votes, 0);
  for (const option of event.options) {
    const row = document.createElement('div');
    row.className = 'vote-row';
    const label = document.createElement('div');
    label.className = 'vote-label';
    const name = document.createElement('span');
    name.textContent = option.option;
    const score = document.createElement('span');
    score.textContent = `${option.votes} · ${total ? Math.round(option.votes * 100 / total) : 0}%`;
    label.append(name, score);
    const track = document.createElement('div');
    track.className = 'vote-track';
    const fill = document.createElement('span');
    fill.style.width = `${total ? Math.round(option.votes * 100 / total) : 0}%`;
    track.append(fill);
    row.append(label, track);
    panel.append(row);
  }
  panel.classList.remove('fade');
  clearTimeout(voteTimer);
  voteTimer = setTimeout(() => panel.classList.add('fade'), 15_000);
}

function handleEvent(event) {
  if (event.type === 'follow') {
    addMessage(event.displayName, `folgt dem Kanal · +${event.amount} ${config.currencyEmoji || config.currencyName}`);
  } else if (event.type === 'redeem') {
    if (event.actionType === 'sound') sound(event.soundFile);
    if (event.actionType === 'rain') rain();
    if (event.actionType === 'confetti') confetti();
    if (event.actionType === 'spotlight') showSpotlight(event.displayName, event.actionName);
    if (event.actionType === 'jumpscare') jumpScare();
    if (event.actionType === 'message') {
      addMessage(event.displayName, `📣 ${event.actionName}`, 'announcement');
      return;
    }
    const detail = event.option ? ` stimmt für „${event.option}“` : ` löst „${event.actionName}“ aus`;
    addMessage(event.displayName, detail, event.actionType === 'vote' ? 'vote' : event.actionType === 'jumpscare' ? 'scare' : '');
  } else if (event.type === 'vote') {
    showVotes(event);
  } else if (event.type === 'test') {
    rain(40);
    addMessage('Verbunden!', `Das Overlay funktioniert · ${config.currencyEmoji || config.currencyName}`);
  }
}

async function start() {
  if (!key) return;
  const protectedQuery = `?key=${encodeURIComponent(key)}`;
  try {
    const response = await fetch(`/overlay/config${protectedQuery}`);
    if (!response.ok) return;
    config = await response.json();
    const events = new EventSource(`/overlay/events${protectedQuery}`);
    events.addEventListener('message', ({ data }) => {
      try { handleEvent(JSON.parse(data)); } catch { /* Ignore malformed events. */ }
    });
  } catch { /* EventSource reconnects automatically after temporary network errors. */ }
}

start();
