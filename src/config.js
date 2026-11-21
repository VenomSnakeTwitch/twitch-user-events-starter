import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const baseAction = {
  id: z.string().regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().min(1).max(40),
  description: z.string().max(120),
  cost: z.number().int().min(1).max(100000),
  cooldownSeconds: z.number().int().min(0).max(86400),
};
const settingsSchema = z.object({
  hubName: z.string().min(1).max(40),
  currencyName: z.string().min(1).max(20),
  currencyEmoji: z.string().min(1).max(8),
  currencyImage: z.string().regex(/^[A-Za-z0-9_-]{1,60}\.(png|jpg|jpeg|webp|gif)$/i).nullable(),
  checkinBananas: z.number().int().min(0).max(10000),
  followBonus: z.number().int().min(0).max(100000),
  watchBananas: z.number().int().min(0).max(10000),
  watchIntervalMinutes: z.number().int().min(1).max(120),
  leaderboardSize: z.number().int().min(3).max(50),
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ ...baseAction, type: z.literal('sound') }).strict(),
    z.object({ ...baseAction, type: z.literal('rain') }).strict(),
    z.object({ ...baseAction, type: z.literal('vote'), options: z.array(z.string().min(1).max(40)).min(2).max(6) }).strict(),
  ])).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  const ids = new Set();
  for (const [index, action] of value.actions.entries()) {
    if (ids.has(action.id)) ctx.addIssue({ code: 'custom', path: ['actions', index, 'id'], message: 'IDs müssen eindeutig sein.' });
    ids.add(action.id);
    if (action.type === 'vote' && new Set(action.options).size !== action.options.length) {
      ctx.addIssue({ code: 'custom', path: ['actions', index, 'options'], message: 'Abstimmungsoptionen müssen eindeutig sein.' });
    }
  }
});

const required = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CHANNEL', 'EVENTSUB_SECRET', 'OVERLAY_KEY', 'TOKEN_ENCRYPTION_KEY'];
const truthy = (value) => typeof value === 'string' && value.trim().length > 0;

export function readConfig(env = process.env) {
  const issues = [];
  const mode = env.NODE_ENV || 'development';
  const port = Number(env.PORT) || 3000;
  const baseUrl = (env.BASE_URL || (mode !== 'production' ? `http://localhost:${port}` : '')).replace(/\/$/, '');
  for (const name of required) if (!truthy(env[name])) issues.push({ name, reason: 'fehlt' });
  if (truthy(env.TWITCH_CHANNEL) && !/^[a-z0-9_]{1,25}$/i.test(env.TWITCH_CHANNEL)) issues.push({ name: 'TWITCH_CHANNEL', reason: 'ungültig' });
  if (truthy(env.EVENTSUB_SECRET) && (env.EVENTSUB_SECRET.length < 10 || env.EVENTSUB_SECRET.length > 100)) issues.push({ name: 'EVENTSUB_SECRET', reason: 'ungültig' });
  if (truthy(env.OVERLAY_KEY) && env.OVERLAY_KEY.length < 32) issues.push({ name: 'OVERLAY_KEY', reason: 'ungültig' });
  if (truthy(env.TOKEN_ENCRYPTION_KEY) && !/^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY)) issues.push({ name: 'TOKEN_ENCRYPTION_KEY', reason: 'ungültig' });
  if (!['development', 'production', 'test'].includes(mode)) issues.push({ name: 'NODE_ENV', reason: 'ungültig' });
  let base;
  try { base = new URL(baseUrl); } catch { issues.push({ name: 'BASE_URL', reason: 'ungültig' }); }
  if (mode === 'production' && base && base.protocol !== 'https:') issues.push({ name: 'BASE_URL', reason: 'ungültig' });
  if (mode === 'production' && !truthy(env.DATABASE_URL)) issues.push({ name: 'DATABASE_URL', reason: 'fehlt' });
  let databaseUrl = env.DATABASE_URL || '';
  if (!databaseUrl && mode !== 'production') databaseUrl = 'file:./data/hub.sqlite';
  if (databaseUrl && !databaseUrl.startsWith('file:') && !/^mysql:\/\//i.test(databaseUrl)) issues.push({ name: 'DATABASE_URL', reason: 'ungültig' });

  const configPath = mode === 'test' && env.HUB_CONFIG_FILE
    ? path.resolve(rootDir, env.HUB_CONFIG_FILE)
    : path.join(rootDir, 'hub.config.json');
  let settings;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const parsed = settingsSchema.safeParse(raw);
    if (!parsed.success) issues.push({ name: 'hub.config.json', reason: 'ungültig' });
    else settings = parsed.data;
  } catch { issues.push({ name: 'hub.config.json', reason: 'ungültig' }); }

  const localHosts = base && ['localhost', '127.0.0.1'].includes(base.hostname);
  const devAlwaysLive = mode !== 'production' && localHosts && env.DEV_ALWAYS_LIVE === 'true';
  const twIdUrl = mode === 'test' && env.TWITCH_ID_URL ? env.TWITCH_ID_URL : 'https://id.twitch.tv';
  const twApiUrl = mode === 'test' && env.TWITCH_API_URL ? env.TWITCH_API_URL : 'https://api.twitch.tv';
  const minuteMs = mode === 'test' && Number(env.HUB_MINUTE_MS) > 0 ? Number(env.HUB_MINUTE_MS) : 60000;
  return {
    mode, port, baseUrl, baseOrigin: base?.origin || '', secure: base?.protocol === 'https:',
    databaseUrl, settings, issues, ready: issues.length === 0,
    clientId: env.TWITCH_CLIENT_ID || '', clientSecret: env.TWITCH_CLIENT_SECRET || '',
    channel: (env.TWITCH_CHANNEL || '').toLowerCase(), eventsubSecret: env.EVENTSUB_SECRET || '',
    overlayKey: env.OVERLAY_KEY || '', tokenKey: env.TOKEN_ENCRYPTION_KEY || '',
    devAlwaysLive, twIdUrl: twIdUrl.replace(/\/$/, ''), twApiUrl: twApiUrl.replace(/\/$/, ''), minuteMs,
    settingsSchema,
  };
}

export { settingsSchema };
