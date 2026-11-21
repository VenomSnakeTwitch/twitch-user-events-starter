import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { readConfig, rootDir, settingsSchema } from './config.js';
import { createDatabase, getSettings, getState, saveSettings, setState } from './db.js';
import { sha256, secureEqual } from './crypto.js';
import { TwitchClient } from './twitch.js';

const config = readConfig();
const app = express();
const publicDir = path.join(rootDir, 'public');
const viewsDir = path.join(rootDir, 'views');
const sessionsFor = new Map();
const overlayClients = new Set();
let db = null;
let twitch = null;
let setupIssues = [...config.issues];
let watchBusy = false;
let cleanupAt = 0;

app.disable('x-powered-by');
if (config.secure) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], mediaSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'rate_limited' }) });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'rate_limited' }) });
const redeemLimiter = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: (req) => req.viewer?.id ? `user:${req.viewer.id}` : ipKeyGenerator(req.ip), standardHeaders: true, legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: 'rate_limited' }) });

function log(message) { process.stdout.write(`${message}\n`); }
function sendError(res, status, error) { return res.status(status).json({ error }); }
function setCookie(res, name, value, { path: cookiePath = '/', maxAge = 0, clear = false } = {}) {
  const pieces = [`${name}=${clear ? '' : encodeURIComponent(value)}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge) pieces.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (clear) pieces.push('Max-Age=0');
  if (config.secure) pieces.push('Secure');
  res.append('Set-Cookie', pieces.join('; '));
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
  }
  return null;
}
function parseCookieId(req) { return readCookie(req, 'hub_session'); }
function sessionCookie(res, value) { setCookie(res, 'hub_session', value, { maxAge: 14 * 24 * 60 * 60 * 1000 }); }
function noSessionCookie(res) { setCookie(res, 'hub_session', '', { clear: true }); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function setupHtml(issues) {
  const rows = issues.length ? issues.map((item) => `<li><strong>${escapeHtml(item.name)}</strong> – ${item.reason === 'fehlt' ? 'fehlt' : 'ungültig'}</li>`).join('') : '<li>Einrichtung wird vorbereitet.</li>';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hub einrichten</title><link rel="stylesheet" href="/style.css"></head><body><main class="panel setup-card"><span class="eyebrow">EINRICHTUNG</span><h1>Dein Hub wird vorbereitet</h1><p>Hinterlege die fehlenden Einstellungen im Hosting-Dashboard, damit Twitch und die Datenbank verbunden werden können.</p><ul>${rows}</ul><p>Die Variablennamen stehen in <a href="/CHECKLISTE.md">der Einrichtungshilfe</a>. Lege dort keine echten Zugangsdaten ab.</p></main></body></html>`;
}

async function optionalSession(req, _res, next) {
  req.viewer = null;
  if (!db) return next();
  const sessionId = parseCookieId(req);
  if (!sessionId || sessionId.length < 20) return next();
  try {
    const row = await db('sessions').join('users', 'sessions.user_id', 'users.id')
      .where({ id_hash: sha256(sessionId) }).andWhere('sessions.expires_at', '>', Date.now())
      .select('users.id', 'users.twitch_id', 'users.login', 'users.display_name', 'users.bananas', 'users.watch_minutes', 'users.follow_bonus_granted', 'users.last_checkin_date').first();
    if (row) req.viewer = row;
    const now = Date.now();
    if (now - cleanupAt > 60 * 60_000) {
      cleanupAt = now;
      db('sessions').where('expires_at', '<=', now).del().catch(() => {});
      db('eventsub_messages').where('received_at', '<', now - 60 * 60_000).del().catch(() => {});
    }
  } catch { /* A database issue is handled by the route's generic error response. */ }
  next();
}

function requireLogin(req, res, next) {
  if (!req.viewer) return sendError(res, 401, 'unauthorized');
  next();
}
function isAdmin(viewer) { return Boolean(viewer && twitch?.channelId && viewer.twitch_id === twitch.channelId); }
function requireAdmin(req, res, next) {
  if (!req.viewer) return sendError(res, 401, 'unauthorized');
  if (!isAdmin(req.viewer)) return sendError(res, 403, 'forbidden');
  next();
}
function csrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path === '/webhooks/twitch') return next();
  if (!req.headers.origin || req.headers.origin !== config.baseOrigin) return sendError(res, 403, 'forbidden_origin');
  if (req.path.startsWith('/api/') && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendError(res, 415, 'unsupported_media_type');
  next();
}
function apiReady(req, res, next) {
  if (!db || !twitch) return sendError(res, 503, 'setup_required');
  next();
}
function currentLive() {
  if (config.devAlwaysLive) return true;
  return getState(db, 'stream_live', 'false').then((value) => value === 'true');
}
function todayBerlin() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function newSession(userId, req, res) {
  const oldId = parseCookieId(req);
  if (oldId) await db('sessions').where({ id_hash: sha256(oldId) }).del();
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await db('sessions').insert({ id_hash: sha256(sessionId), user_id: userId, created_at: now, expires_at: now + 14 * 24 * 60 * 60 * 1000 });
  sessionCookie(res, sessionId);
}

async function loginOrUpdateUser(twitchUser) {
  return db.transaction(async (trx) => {
    const now = Date.now();
    let user = await trx('users').where({ twitch_id: twitchUser.id }).first();
    if (user) {
      await trx('users').where({ id: user.id }).update({ login: twitchUser.login, display_name: twitchUser.display_name, updated_at: now });
    } else {
      const ids = await trx('users').insert({ twitch_id: twitchUser.id, login: twitchUser.login, display_name: twitchUser.display_name, bananas: 0, watch_minutes: 0, follow_bonus_granted: false, last_checkin_date: null, created_at: now, updated_at: now });
      user = await trx('users').where({ id: Array.isArray(ids) ? ids[0] : ids }).first();
    }
    const follow = await trx('follows').where({ twitch_id: twitchUser.id }).first();
    if (follow && !follow.bonus_granted && !user.follow_bonus_granted) {
      const settings = JSON.parse((await trx('settings').where({ key: 'hub' }).first()).value);
      await trx('users').where({ id: user.id }).update({ bananas: trx.raw('bananas + ?', [settings.followBonus]), follow_bonus_granted: true, updated_at: now });
      await trx('follows').where({ twitch_id: twitchUser.id }).update({ bonus_granted: true });
    }
    return trx('users').where({ twitch_id: twitchUser.id }).first();
  });
}

function startAuthorization(req, res, flow) {
  const state = crypto.randomBytes(32).toString('base64url');
  setCookie(res, 'hub_oauth_state', `${flow}.${state}`, { path: '/auth', maxAge: 10 * 60_000 });
  const scopes = flow === 'streamer' ? 'moderator:read:followers moderator:read:chatters' : '';
  const params = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: `${config.baseUrl}/auth/callback`, scope: scopes, state });
  return res.redirect(302, `${config.twIdUrl}/oauth2/authorize?${params}`);
}

async function callback(req, res) {
  const cookie = readCookie(req, 'hub_oauth_state');
  setCookie(res, 'hub_oauth_state', '', { path: '/auth', clear: true });
  if (req.query.error) return res.status(400).type('html').send('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anmeldung abgebrochen</title><link rel="stylesheet" href="/style.css"><body><main class="panel setup-card"><h1>Anmeldung abgebrochen</h1><p>Du kannst es jederzeit erneut versuchen.</p><a href="/">Zurück</a></main></body></html>');
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!state || !code) return res.status(400).type('text').send('Anmeldung fehlgeschlagen.');
  const split = cookie?.indexOf('.') ?? -1;
  if (split < 0 || !secureEqual(cookie.slice(split + 1), state)) return res.status(403).type('text').send('Anmeldung fehlgeschlagen.');
  const flow = cookie.slice(0, split);
  if (!['viewer', 'streamer'].includes(flow)) return res.status(403).type('text').send('Anmeldung fehlgeschlagen.');
  try {
    const tokens = await twitch.exchangeCode(code, `${config.baseUrl}/auth/callback`);
    const identity = await twitch.getIdentity(tokens.access_token);
    if (!identity?.id || !identity.login || !identity.display_name) {
      await twitch.revoke(tokens.access_token);
      return res.status(400).type('text').send('Anmeldung fehlgeschlagen.');
    }
    const isChannel = identity.id === twitch.channelId;
    if (flow === 'streamer') {
      if (!isChannel) {
        await twitch.revoke(tokens.access_token);
        if (tokens.refresh_token) await twitch.revoke(tokens.refresh_token);
        return res.status(403).type('text').send('Dieses Konto gehört nicht zum verbundenen Kanal.');
      }
      await twitch.storeStreamerTokens(tokens);
      await twitch.revoke(tokens.access_token);
      if (config.baseUrl.startsWith('https://')) await twitch.ensureSubscriptions();
    } else {
      await twitch.revoke(tokens.access_token);
      if (tokens.refresh_token) await twitch.revoke(tokens.refresh_token);
    }
    const user = await loginOrUpdateUser(identity);
    await newSession(user.id, req, res);
    return res.redirect(302, flow === 'streamer' ? '/admin' : '/');
  } catch {
    return res.status(400).type('text').send('Anmeldung fehlgeschlagen. Bitte versuche es erneut.');
  }
}

function overlayKeyValid(req) { return secureEqual(req.query.key || '', config.overlayKey); }
function publish(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of overlayClients) {
    try { res.write(line); } catch { overlayClients.delete(res); }
  }
}
function overlayVotePayload(settings, voteResetAt) {
  const action = settings.actions.find((entry) => entry.type === 'vote');
  if (!action) return { actionId: null, options: [] };
  return db('redemptions').where({ action_id: action.id }).andWhere('created_at', '>=', Number(voteResetAt || 0))
    .select('option').count({ votes: '*' }).groupBy('option').then((rows) => {
      const counts = new Map(rows.map((row) => [row.option, Number(row.votes)]));
      return { actionId: action.id, options: action.options.map((option) => ({ option, votes: counts.get(option) || 0 })) };
    });
}

async function applyFollow(event) {
  if (!event?.user_id) return;
  const existing = await db('follows').where({ twitch_id: event.user_id }).first();
  if (existing?.bonus_granted) return;
  await db.transaction(async (trx) => {
    const now = Date.now();
    const known = await trx('users').where({ twitch_id: event.user_id }).first();
    if (known && !known.follow_bonus_granted) {
      const settings = JSON.parse((await trx('settings').where({ key: 'hub' }).first()).value);
      await trx('users').where({ id: known.id }).update({ bananas: trx.raw('bananas + ?', [settings.followBonus]), follow_bonus_granted: true, updated_at: now });
      const old = await trx('follows').where({ twitch_id: event.user_id }).first();
      if (old) await trx('follows').where({ twitch_id: event.user_id }).update({ bonus_granted: true });
      else await trx('follows').insert({ twitch_id: event.user_id, bonus_granted: true, created_at: now });
      publish({ type: 'follow', displayName: event.user_name || event.user_login || 'Ein Zuschauer', amount: settings.followBonus });
    } else if (!known) {
      if (!existing) await trx('follows').insert({ twitch_id: event.user_id, bonus_granted: false, created_at: now });
    }
  });
}

async function processWebhook(payload, messageType) {
  const eventType = payload?.subscription?.type;
  if (messageType === 'webhook_callback_verification' || messageType === 'revocation') return;
  const event = payload?.event;
  if (!event || event.broadcaster_user_id !== twitch.channelId) return;
  if (eventType === 'stream.online') {
    await setState(db, 'stream_live', 'true');
    await setState(db, 'stream_started_at', String(Date.now()));
  } else if (eventType === 'stream.offline') {
    await setState(db, 'stream_live', 'false');
    await setState(db, 'vote_reset_at', String(Date.now()));
  } else if (eventType === 'channel.follow' && (await getState(db, 'streamer_authorized', 'false')) === 'true') {
    await applyFollow(event);
  }
}

async function runWatchTick() {
  if (!db || !twitch || watchBusy) return;
  watchBusy = true;
  try {
    const settings = await getSettings(db);
    if (settings.watchBananas <= 0 || (await currentLive()) !== true || (await getState(db, 'streamer_authorized', 'false')) !== 'true') return;
    let ids = await twitch.getChatters();
    if (twitch.channelId) ids = ids.filter((id) => id !== twitch.channelId);
    if (!ids.length || (await currentLive()) !== true) return;
    const known = new Set();
    for (let start = 0; start < ids.length; start += 500) {
      const block = ids.slice(start, start + 500);
      const users = await db('users').whereIn('twitch_id', block).select('twitch_id');
      for (const user of users) known.add(user.twitch_id);
    }
    const active = [...known];
    if (!active.length || (await currentLive()) !== true) return;
    for (let start = 0; start < active.length; start += 500) {
      const block = active.slice(start, start + 500);
      await db('users').whereIn('twitch_id', block).update({ watch_minutes: db.raw('watch_minutes + 1'), updated_at: Date.now() });
      await db('users').whereIn('twitch_id', block).where('watch_minutes', '>=', settings.watchIntervalMinutes)
        .update({ bananas: db.raw('bananas + ?', [settings.watchBananas]), watch_minutes: db.raw('watch_minutes - ?', [settings.watchIntervalMinutes]), updated_at: Date.now() });
    }
    await db('users').where('watch_minutes', '>', settings.watchIntervalMinutes).update({ watch_minutes: settings.watchIntervalMinutes });
  } catch { log('Zuschauer-Aktualisierung fehlgeschlagen; erneuter Versuch beim nächsten Durchlauf.'); }
  finally { watchBusy = false; }
}

function requireReady(req, res, next) {
  if (!db || !twitch || !twitch.channelId) return sendError(res, 503, 'setup_required');
  next();
}

app.use(optionalSession);
app.use(csrf);
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.use('/api', apiLimiter);
app.use('/auth', authLimiter);

app.post('/webhooks/twitch', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  if (!db || !twitch) return res.status(503).end();
  const messageId = req.headers['twitch-eventsub-message-id'];
  const timestamp = req.headers['twitch-eventsub-message-timestamp'];
  const signature = req.headers['twitch-eventsub-message-signature'];
  const type = req.headers['twitch-eventsub-message-type'];
  if (typeof messageId !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string' || !Buffer.isBuffer(req.body)) return res.status(403).end();
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 10 * 60_000) return res.status(403).end();
  const expected = `sha256=${crypto.createHmac('sha256', config.eventsubSecret).update(messageId + timestamp).update(req.body).digest('hex')}`;
  if (!secureEqual(signature, expected)) return res.status(403).end();
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
  try { await db('eventsub_messages').insert({ message_id: messageId, received_at: Date.now() }); }
  catch { return res.status(204).end(); }
  if (type === 'webhook_callback_verification') return res.status(200).type('text/plain').send(String(payload.challenge || ''));
  if (type === 'revocation') { log('Twitch hat ein EventSub-Abo widerrufen.'); return res.status(204).end(); }
  try {
    await processWebhook(payload, type);
    return res.status(204).end();
  } catch {
    await db('eventsub_messages').where({ message_id: messageId }).del().catch(() => {});
    return res.status(500).end();
  }
});

app.use(express.json({ limit: '10kb', type: 'application/json' }));

app.get('/auth/login', requireReady, (req, res) => startAuthorization(req, res, 'viewer'));
app.get('/auth/streamer', requireReady, (req, res) => startAuthorization(req, res, 'streamer'));
app.get('/auth/callback', requireReady, callback);
app.post('/auth/logout', requireReady, requireLogin, async (req, res) => {
  const id = parseCookieId(req);
  if (id) await db('sessions').where({ id_hash: sha256(id) }).del();
  noSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/config', requireReady, async (_req, res, next) => {
  try { res.json({ ...(await getSettings(db)), isLive: await currentLive() }); } catch (e) { next(e); }
});
app.get('/api/me', requireReady, requireLogin, async (req, res) => {
  const date = todayBerlin();
  res.json({ displayName: req.viewer.display_name, login: req.viewer.login, bananas: req.viewer.bananas, isLive: await currentLive(), checkedInToday: req.viewer.last_checkin_date === date, isAdmin: isAdmin(req.viewer), watchMinutes: req.viewer.watch_minutes });
});
app.post('/api/checkin', requireReady, requireLogin, async (req, res, next) => {
  try {
    const settings = await getSettings(db);
    if (!(await currentLive())) return sendError(res, 409, 'not_live');
    const result = await db.transaction(async (trx) => {
      const user = await trx('users').where({ id: req.viewer.id }).forUpdate().first();
      if (!user) return { error: 'unauthorized' };
      const today = todayBerlin();
      if (user.last_checkin_date === today) return { error: 'already_checked_in' };
      if (!(await currentLive())) return { error: 'not_live' };
      await trx('users').where({ id: user.id }).update({ bananas: trx.raw('bananas + ?', [settings.checkinBananas]), last_checkin_date: today, updated_at: Date.now() });
      const updated = await trx('users').where({ id: user.id }).first();
      return { bananas: updated.bananas };
    });
    if (result.error) return sendError(res, result.error === 'unauthorized' ? 401 : 409, result.error);
    res.json(result);
  } catch (e) { next(e); }
});
app.post('/api/redeem', requireReady, requireLogin, redeemLimiter, async (req, res, next) => {
  try {
    const schema = z.object({ actionId: z.string().min(1).max(50), option: z.string().max(100).optional(), spotlightName: z.string().trim().min(1).max(25).optional() }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, 'invalid_input');
    const settings = await getSettings(db);
    const action = settings.actions.find((entry) => entry.id === parsed.data.actionId);
    if (!action) return sendError(res, 400, 'unknown_action');
    if (action.type === 'spotlight' && !parsed.data.spotlightName) return sendError(res, 400, 'invalid_spotlight_name');
    if (parsed.data.spotlightName && !/^[a-z0-9_]{1,25}$/i.test(parsed.data.spotlightName)) return sendError(res, 400, 'invalid_spotlight_name');
    if (action.type !== 'spotlight' && parsed.data.spotlightName !== undefined) return sendError(res, 400, 'invalid_input');
    if (action.type === 'vote' && (!parsed.data.option || !action.options.includes(parsed.data.option))) return sendError(res, 400, 'invalid_option');
    if (action.type !== 'vote' && parsed.data.option !== undefined) return sendError(res, 400, 'invalid_input');
    if (!(await currentLive())) return sendError(res, 409, 'not_live');
    const now = Date.now();
    const result = await db.transaction(async (trx) => {
      const user = await trx('users').where({ id: req.viewer.id }).forUpdate().first();
      if (!user) return { error: 'unauthorized' };
      const last = await trx('redemptions').where({ user_id: user.id, action_id: action.id }).orderBy('created_at', 'desc').first();
      const remaining = action.cooldownSeconds - Math.floor((now - Number(last?.created_at || 0)) / 1000);
      if (last && remaining > 0) return { error: 'cooldown', retry: remaining };
      const changed = await trx('users').where({ id: user.id }).where('bananas', '>=', action.cost).update({ bananas: trx.raw('bananas - ?', [action.cost]), updated_at: now });
      if (!changed) return { error: 'not_enough_bananas' };
      await trx('redemptions').insert({ user_id: user.id, action_id: action.id, option: parsed.data.option || null, cost: action.cost, created_at: now });
      const updated = await trx('users').where({ id: user.id }).first();
      return { bananas: updated.bananas };
    });
    if (result.error) {
      if (result.error === 'cooldown') res.set('Retry-After', String(result.retry));
      const status = { cooldown: 429, not_enough_bananas: 402, unauthorized: 401 }[result.error] || 400;
      return sendError(res, status, result.error);
    }
    const event = { type: 'redeem', actionId: action.id, actionType: action.type, actionName: action.name, displayName: req.viewer.display_name, ...(action.type === 'sound' && action.soundFile ? { soundFile: action.soundFile } : {}), ...(action.type === 'spotlight' ? { spotlightName: parsed.data.spotlightName, channelUrl: `https://www.twitch.tv/${encodeURIComponent(parsed.data.spotlightName)}` } : {}), ...(parsed.data.option ? { option: parsed.data.option } : {}) };
    publish(event);
    if (action.type === 'vote') {
      const voteResetAt = await getState(db, 'vote_reset_at', '0');
      publish({ type: 'vote', ...(await overlayVotePayload(settings, voteResetAt)) });
    }
    res.json({ bananas: result.bananas, actionId: action.id });
  } catch (e) { next(e); }
});
app.get('/api/leaderboard', requireReady, async (_req, res, next) => {
  try {
    const settings = await getSettings(db);
    const rows = await db('users').where('bananas', '>', 0).select('display_name', 'bananas').orderBy('bananas', 'desc').orderBy('display_name', 'asc').limit(settings.leaderboardSize);
    res.json({ entries: rows.map((row) => ({ displayName: row.display_name, bananas: row.bananas })) });
  } catch (e) { next(e); }
});
app.get('/api/vote', requireReady, async (_req, res, next) => {
  try { const settings = await getSettings(db); res.json(await overlayVotePayload(settings, await getState(db, 'vote_reset_at', '0'))); }
  catch (e) { next(e); }
});
app.post('/api/me/delete', requireReady, requireLogin, async (req, res, next) => {
  try {
    await db.transaction(async (trx) => {
      await trx('sessions').where({ user_id: req.viewer.id }).del();
      await trx('follows').where({ twitch_id: req.viewer.twitch_id }).del();
      await trx('users').where({ id: req.viewer.id }).del();
    });
    noSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/admin', async (req, res) => {
  if (!db || !twitch?.channelId) return sendError(res, 503, 'setup_required');
  if (!req.viewer) return res.redirect(302, '/auth/streamer');
  if (!isAdmin(req.viewer)) return res.status(403).type('text').send('Kein Zugriff.');
  return res.sendFile(path.join(viewsDir, 'admin.html'));
});
app.get('/api/admin/settings', requireReady, requireAdmin, async (_req, res, next) => {
  try {
    const row = await db('streamer_auth').where({ id: 1 }).first();
    res.json({ settings: await getSettings(db), streamerAuthorized: (await getState(db, 'streamer_authorized', 'false')) === 'true', streamerNeedsReconnect: (await getState(db, 'streamer_needs_reconnect', 'false')) === 'true', streamerScopes: row ? await twitch.getStreamerScopes() : [] });
  } catch (e) { next(e); }
});
app.put('/api/admin/settings', requireReady, requireAdmin, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input', issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
    if (parsed.data.currencyImage) {
      const imagePath = path.join(publicDir, 'waehrung', path.basename(parsed.data.currencyImage));
      if (!fs.existsSync(imagePath) || path.dirname(imagePath) !== path.join(publicDir, 'waehrung')) return sendError(res, 400, 'invalid_input');
    }
    for (const action of parsed.data.actions) {
      if (action.type !== 'sound' || !action.soundFile) continue;
      const soundDir = path.join(publicDir, 'sounds');
      const soundPath = path.join(soundDir, path.basename(action.soundFile));
      if (!/^[\p{L}\p{N} _-]{1,100}\.(mp3|wav|ogg|m4a)$/iu.test(action.soundFile) || path.dirname(soundPath) !== soundDir || !fs.existsSync(soundPath)) return sendError(res, 400, 'invalid_input');
    }
    const previous = await getSettings(db);
    const beforeVote = previous.actions.find((action) => action.type === 'vote');
    const afterVote = parsed.data.actions.find((action) => action.type === 'vote');
    if (beforeVote?.id !== afterVote?.id || JSON.stringify(beforeVote?.options || []) !== JSON.stringify(afterVote?.options || [])) await setState(db, 'vote_reset_at', String(Date.now()));
    await saveSettings(db, parsed.data);
    res.json({ settings: parsed.data });
  } catch (e) { next(e); }
});
app.post('/api/admin/users/balance', requireReady, requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      target: z.enum(['self', 'user']),
      login: z.string().trim().min(1).max(100).optional(),
      operation: z.enum(['add', 'subtract', 'set']),
      amount: z.number().int().min(0).max(2_147_483_647),
    }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success || (parsed.data?.target === 'user' && !parsed.data.login)) return sendError(res, 400, 'invalid_input');
    const { target, login, operation, amount } = parsed.data;
    const result = await db.transaction(async (trx) => {
      let query = trx('users');
      query = target === 'self' ? query.where({ id: req.viewer.id }) : query.whereRaw('LOWER(login) = ?', [login.toLowerCase()]);
      const user = await query.forUpdate().first();
      if (!user) return { error: 'user_not_found' };
      let nextBalance = amount;
      if (operation === 'add') nextBalance = user.bananas + amount;
      if (operation === 'subtract') nextBalance = user.bananas - amount;
      if (nextBalance < 0) return { error: 'insufficient_balance' };
      if (nextBalance > 2_147_483_647) return { error: 'balance_limit' };
      await trx('users').where({ id: user.id }).update({ bananas: nextBalance, updated_at: Date.now() });
      return { displayName: user.display_name, login: user.login, bananas: nextBalance };
    });
    if (result.error) return sendError(res, result.error === 'user_not_found' ? 404 : 400, result.error);
    res.json(result);
  } catch (e) { next(e); }
});
app.get('/api/admin/overlay-url', requireReady, requireAdmin, (req, res) => res.json({ url: `${config.baseUrl}/overlay?key=${encodeURIComponent(config.overlayKey)}`, width: 1920, height: 1080 }));
app.post('/api/admin/overlay/test', requireReady, requireAdmin, (_req, res) => { publish({ type: 'test' }); res.json({ ok: true }); });
app.get('/api/admin/currency-images', requireReady, requireAdmin, (_req, res, next) => {
  fs.readdir(path.join(publicDir, 'waehrung'), (error, files) => {
    if (error) return next(error);
    res.json({ images: files.filter((file) => /^[A-Za-z0-9_-]{1,60}\.(png|jpg|jpeg|webp|gif)$/i.test(file)) });
  });
});
app.get('/api/admin/sounds', requireReady, requireAdmin, (_req, res, next) => {
  fs.readdir(path.join(publicDir, 'sounds'), (error, files) => {
    if (error) return next(error);
    res.json({ sounds: files.filter((file) => /^[\p{L}\p{N} _-]{1,100}\.(mp3|wav|ogg|m4a)$/iu.test(file)) });
  });
});
app.post('/api/admin/streamer/revoke', requireReady, requireAdmin, async (_req, res, next) => {
  try {
    try { const token = await twitch.streamerAccessToken(); await twitch.revoke(token); } catch { /* Credential may already be invalid. */ }
    await twitch.forgetStreamer(false);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/overlay', requireReady, (req, res) => {
  if (!overlayKeyValid(req)) return res.status(403).type('text').send('Forbidden');
  res.sendFile(path.join(viewsDir, 'overlay.html'));
});
app.get('/overlay/config', requireReady, async (req, res, next) => {
  if (!overlayKeyValid(req)) return sendError(res, 403, 'forbidden');
  try {
    const settings = await getSettings(db);
    res.json({ currencyName: settings.currencyName, currencyEmoji: settings.currencyEmoji, currencyImage: settings.currencyImage, followBonus: settings.followBonus });
  } catch (e) { next(e); }
});
app.get('/overlay/events', requireReady, (req, res) => {
  if (!overlayKeyValid(req)) return res.status(403).end();
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  overlayClients.add(res);
  const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(timer); overlayClients.delete(res); } }, 25_000);
  timer.unref?.();
  req.on('close', () => { clearInterval(timer); overlayClients.delete(res); });
});

app.get('/', (_req, res, next) => {
  if (!config.ready || !db) return res.status(200).type('html').send(setupHtml(setupIssues));
  next();
});
app.use('/CHECKLISTE.md', express.static(path.join(rootDir, 'CHECKLISTE.md')));
app.use(express.static(publicDir, { fallthrough: true, index: 'index.html', maxAge: config.mode === 'production' ? '1h' : 0 }));
app.use((_req, res, next) => (!config.ready || !db ? sendError(res, 503, 'setup_required') : next()));
app.use((_req, res) => sendError(res, 404, 'not_found'));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.end();
  if (error?.type === 'entity.too.large') return sendError(res, 413, 'payload_too_large');
  if (error instanceof SyntaxError && error.status === 400) return sendError(res, 400, 'bad_request');
  log('Interner Fehler bei einer Anfrage.');
  return sendError(res, 500, 'internal_error');
});

async function bootstrap() {
  if (config.ready) {
    try { db = await createDatabase(config.databaseUrl, config.settings); }
    catch (error) {
      setupIssues.push({ name: 'DATABASE_URL', reason: 'ungültig' });
      const databaseError = /^[A-Z0-9_]{1,64}$/.test(String(error?.code || '')) ? error.code : 'UNKNOWN';
      const missingTable = databaseError === 'ER_NO_SUCH_TABLE'
        ? String(error?.sqlMessage || '').match(/Table '[^']*\.([^'.]+)' doesn't exist/i)?.[1]
        : null;
      const tableDetail = missingTable && /^[A-Za-z0-9_]{1,64}$/.test(missingTable) ? `, Tabelle ${missingTable}` : '';
      log(`Datenbankverbindung fehlgeschlagen (${databaseError}${tableDetail}); die App startet im Einrichtungsmodus.`);
    }
  }
  if (db && config.ready) {
    twitch = new TwitchClient(config, db, log);
    const init = twitch.initialize().catch(() => { log('Twitch-Verbindung wird im Hintergrund erneut versucht.'); });
    await Promise.race([init, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (config.devAlwaysLive) await setState(db, 'stream_live', 'true');
  }
  const server = app.listen(config.port, '0.0.0.0', () => {
    log(`Zuschauer-Hub läuft auf Port ${config.port}.`);
    if (db && twitch && config.baseUrl.startsWith('https://')) setTimeout(() => twitch.ensureSubscriptions().catch(() => {}), 1000).unref?.();
  });
  if (db && twitch) {
    const liveTimer = setInterval(() => {
      twitch.pollLive().catch(() => log('Twitch-Live-Status konnte nicht aktualisiert werden.'));
      if (!twitch.channelId) twitch.initialize().catch(() => {});
      if (config.baseUrl.startsWith('https://')) twitch.ensureSubscriptions().catch(() => {});
    }, 5 * 60_000);
    liveTimer.unref?.();
    const watchTimer = setInterval(runWatchTick, config.minuteMs);
    watchTimer.unref?.();
    const messageTimer = setInterval(() => db('eventsub_messages').where('received_at', '<', Date.now() - 60 * 60_000).del().catch(() => {}), 60 * 60_000);
    messageTimer.unref?.();
  }
  const close = async () => {
    for (const client of overlayClients) client.end();
    server.close();
    await db?.destroy();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return { app, server, db, close };
}

export const runtime = await bootstrap();
