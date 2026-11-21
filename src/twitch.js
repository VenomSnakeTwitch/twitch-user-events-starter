import { decryptToken, encryptToken } from './crypto.js';
import { getState, setState } from './db.js';

export class TwitchClient {
  constructor(config, db, logger = () => {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.channelId = null;
    this.appToken = null;
    this.appTokenExpiresAt = 0;
    this.streamerToken = null;
    this.streamerTokenExpiresAt = 0;
    this.refreshingStreamer = null;
  }

  async tokenRequest(parameters) {
    const response = await fetch(`${this.config.twIdUrl}/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...parameters }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error('twitch_token_failed');
    return data;
  }

  async appAccessToken() {
    if (this.appToken && this.appTokenExpiresAt > Date.now() + 30000) return this.appToken;
    const data = await this.tokenRequest({ grant_type: 'client_credentials' });
    this.appToken = data.access_token;
    this.appTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
    return this.appToken;
  }

  async helix(path, { token, body, method = 'GET', retry = true } = {}) {
    const access = token || await this.appAccessToken();
    const response = await fetch(`${this.config.twApiUrl}/helix${path}`, {
      method,
      headers: { 'Client-Id': this.config.clientId, Authorization: `Bearer ${access}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && !token && retry) {
      this.appToken = null;
      return this.helix(path, { token: await this.appAccessToken(), body, method, retry: false });
    }
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error('twitch_api_failed');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async initialize() {
    const token = await this.appAccessToken();
    const users = await this.helix(`/users?login=${encodeURIComponent(this.config.channel)}`, { token });
    this.channelId = users?.data?.[0]?.id || null;
    if (!this.channelId) throw new Error('channel_not_found');
    const live = await this.fetchLive();
    await setState(this.db, 'stream_live', String(this.config.devAlwaysLive || live));
    return this.channelId;
  }

  async exchangeCode(code, redirectUri) {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  async getIdentity(accessToken) {
    const result = await this.helix('/users', { token: accessToken });
    return result?.data?.[0] || null;
  }

  async revoke(token) {
    await fetch(`${this.config.twIdUrl}/oauth2/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, token }),
    }).catch(() => {});
  }

  async storeStreamerTokens(tokens) {
    const encrypted = encryptToken(tokens.refresh_token, this.config.tokenKey);
    const row = { id: 1, refresh_token_enc: encrypted, scopes: JSON.stringify(tokens.scope || []), updated_at: Date.now() };
    const exists = await this.db('streamer_auth').where({ id: 1 }).first();
    if (exists) await this.db('streamer_auth').where({ id: 1 }).update(row);
    else await this.db('streamer_auth').insert(row);
    this.streamerToken = tokens.access_token;
    this.streamerTokenExpiresAt = Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000;
    await setState(this.db, 'streamer_authorized', 'true');
    await setState(this.db, 'streamer_needs_reconnect', 'false');
  }

  async forgetStreamer(reconnect = false) {
    await this.db('streamer_auth').where({ id: 1 }).del().catch(() => {});
    this.streamerToken = null;
    this.streamerTokenExpiresAt = 0;
    await setState(this.db, 'streamer_authorized', 'false');
    if (reconnect) await setState(this.db, 'streamer_needs_reconnect', 'true');
    else await setState(this.db, 'streamer_needs_reconnect', 'false');
  }

  async streamerAccessToken() {
    if (this.streamerToken && this.streamerTokenExpiresAt > Date.now() + 30000) return this.streamerToken;
    if (this.refreshingStreamer) return this.refreshingStreamer;
    this.refreshingStreamer = (async () => {
      const row = await this.db('streamer_auth').where({ id: 1 }).first();
      if (!row) throw new Error('streamer_not_authorized');
      let refresh;
      try { refresh = decryptToken(row.refresh_token_enc, this.config.tokenKey); }
      catch {
        this.logger('Streamer-Verbindung muss erneut eingerichtet werden.');
        await this.forgetStreamer(true);
        throw new Error('streamer_needs_reconnect');
      }
      try {
        const data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
        if (data.refresh_token) await this.storeStreamerTokens(data);
        else {
          this.streamerToken = data.access_token;
          this.streamerTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
        }
        return this.streamerToken;
      } catch {
        await this.forgetStreamer(true);
        throw new Error('streamer_needs_reconnect');
      }
    })();
    try { return await this.refreshingStreamer; }
    finally { this.refreshingStreamer = null; }
  }

  async streamerHelix(path, bodyOptions = {}) {
    let token = await this.streamerAccessToken();
    try { return await this.helix(path, { ...bodyOptions, token }); }
    catch (error) {
      if (error.status !== 401) throw error;
      this.streamerToken = null;
      this.streamerTokenExpiresAt = 0;
      token = await this.streamerAccessToken();
      return this.helix(path, { ...bodyOptions, token });
    }
  }

  async fetchLive() {
    if (!this.channelId) return false;
    try {
      const response = await this.helix(`/streams?user_id=${encodeURIComponent(this.channelId)}`);
      return Boolean(response?.data?.length);
    } catch { this.logger('Twitch-Live-Status konnte nicht aktualisiert werden.'); return false; }
  }

  async pollLive() {
    const isLive = this.config.devAlwaysLive || await this.fetchLive();
    const wasLive = (await getState(this.db, 'stream_live', 'false')) === 'true';
    await setState(this.db, 'stream_live', String(Boolean(isLive)));
    if (wasLive && !isLive) await setState(this.db, 'vote_reset_at', String(Date.now()));
  }

  async getChatters() {
    const result = [];
    let cursor = '';
    for (let pages = 0; pages < 50; pages++) {
      const query = new URLSearchParams({ broadcaster_id: this.channelId, moderator_id: this.channelId, first: '1000' });
      if (cursor) query.set('after', cursor);
      const data = await this.streamerHelix(`/chat/chatters?${query}`);
      result.push(...(data?.data || []).map((row) => row.user_id).filter(Boolean));
      cursor = data?.pagination?.cursor || '';
      if (!cursor) break;
    }
    return [...new Set(result)];
  }

  async ensureSubscriptions() {
    try {
      const existing = await this.helix('/eventsub/subscriptions');
      const entries = existing?.data || [];
      const wanted = [
        { type: 'stream.online', version: '1', condition: { broadcaster_user_id: this.channelId } },
        { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: this.channelId } },
      ];
      if ((await getState(this.db, 'streamer_authorized', 'false')) === 'true') wanted.push({
        type: 'channel.follow', version: '2', condition: { broadcaster_user_id: this.channelId, moderator_user_id: this.channelId },
      });
      for (const wantedSub of wanted) {
        const same = entries.some((entry) => entry.type === wantedSub.type && entry.version === wantedSub.version && JSON.stringify(entry.condition) === JSON.stringify(wantedSub.condition) && entry.status !== 'authorization_revoked' && entry.status !== 'webhook_callback_verification_failed');
        if (!same) {
          const subscription = { ...wantedSub, transport: { method: 'webhook', callback: `${this.config.baseUrl}/webhooks/twitch`, secret: this.config.eventsubSecret } };
          if (wantedSub.type === 'channel.follow') await this.streamerHelix('/eventsub/subscriptions', { method: 'POST', body: subscription });
          else await this.helix('/eventsub/subscriptions', { method: 'POST', body: subscription });
        }
      }
    } catch { this.logger('Twitch-EventSub-Abos konnten nicht aktualisiert werden.'); }
  }

  async getStreamerScopes() {
    const row = await this.db('streamer_auth').where({ id: 1 }).first();
    if (!row) return [];
    try { return JSON.parse(row.scopes); } catch { return []; }
  }
}
