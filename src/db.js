import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';
import { rootDir } from './config.js';

function makeClient(databaseUrl) {
  if (databaseUrl.startsWith('file:')) {
    let filename = databaseUrl.slice(5);
    if (!path.isAbsolute(filename)) filename = path.resolve(rootDir, filename);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    return knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true, pool: { min: 1, max: 1 }, acquireConnectionTimeout: 10000 });
  }
  const url = new URL(databaseUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: process.env.DATABASE_PASSWORD ?? decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
  if (process.env.DATABASE_SSL === 'true') connection.ssl = { minVersion: 'TLSv1.2' };
  return knex({ client: 'mysql2', connection, pool: { min: 0, max: 8 }, acquireConnectionTimeout: 10000, charset: 'utf8mb4' });
}

export async function createDatabase(databaseUrl, initialSettings) {
  const db = makeClient(databaseUrl);
  try {
    await db.raw('SELECT 1');
    await migrate(db);
    const existing = await db('settings').where({ key: 'hub' }).first();
    if (!existing) await db('settings').insert({ key: 'hub', value: JSON.stringify(initialSettings), updated_at: Date.now() });
    return db;
  } catch (error) {
    await db.destroy().catch(() => {});
    throw error;
  }
}

async function migrate(db) {
  const schema = db.schema;
  const mysql = db.client.config.client !== 'better-sqlite3';
  const createTableIfMissing = async (name, create) => {
    if (!mysql && await schema.hasTable(name)) return;
    try { await schema.createTable(name, create); }
    catch (error) { if (!(mysql && error?.code === 'ER_TABLE_EXISTS_ERROR')) throw error; }
  };
  await createTableIfMissing('users', (t) => {
    t.increments('id').primary();
    t.string('twitch_id', 64).notNullable().unique();
    t.string('login', 100).notNullable();
    t.string('display_name', 255).notNullable();
    t.integer('bananas').notNullable().defaultTo(0);
    t.integer('watch_minutes').notNullable().defaultTo(0);
    t.boolean('follow_bonus_granted').notNullable().defaultTo(false);
    t.string('last_checkin_date', 10).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('sessions', (t) => {
    t.string('id_hash', 64).primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable().index();
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('follows', (t) => {
    t.string('twitch_id', 64).primary();
    t.boolean('bonus_granted').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('eventsub_messages', (t) => {
    t.string('message_id', 100).primary();
    t.bigInteger('received_at').notNullable().index();
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('redemptions', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('action_id', 30).notNullable();
    t.string('option', 100).nullable();
    t.integer('cost').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['user_id', 'action_id', 'created_at']);
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('app_state', (t) => {
    t.string('key', 80).primary();
    t.text('value').notNullable();
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('settings', (t) => {
    t.string('key', 40).primary();
    t.text('value').notNullable();
    t.bigInteger('updated_at').notNullable();
    if (mysql) t.charset('utf8mb4');
  });
  await createTableIfMissing('streamer_auth', (t) => {
    t.integer('id').primary();
    t.text('refresh_token_enc').notNullable();
    t.text('scopes').notNullable();
    t.bigInteger('updated_at').notNullable();
    if (mysql) t.charset('utf8mb4');
  });
}

export async function getSettings(db) {
  const row = await db('settings').where({ key: 'hub' }).first();
  if (!row) throw new Error('settings_missing');
  return JSON.parse(row.value);
}

export async function getState(db, key, fallback = null) {
  const row = await db('app_state').where({ key }).first();
  return row ? row.value : fallback;
}

export async function setState(db, key, value) {
  const row = { key, value: String(value) };
  const found = await db('app_state').where({ key }).first();
  if (found) await db('app_state').where({ key }).update({ value: row.value });
  else await db('app_state').insert(row);
}

export async function saveSettings(db, settings) {
  await db('settings').where({ key: 'hub' }).update({ value: JSON.stringify(settings), updated_at: Date.now() });
}
