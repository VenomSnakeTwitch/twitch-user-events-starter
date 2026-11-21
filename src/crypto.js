import crypto from 'node:crypto';

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function secureEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b) && String(left ?? '').length === String(right ?? '').length;
}

export function encryptToken(token, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptToken(value, keyHex) {
  const [version, iv, tag, body] = String(value).split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('token_invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
