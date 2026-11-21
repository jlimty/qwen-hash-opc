import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const params = { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 };
const derive = (password, salt) => new Promise((resolve, reject) => {
  scrypt(password.normalize('NFKC'), salt, 64, params, (error, key) => (error ? reject(error) : resolve(key)));
});

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const match = /^([0-9a-f]{32}):([0-9a-f]{128})$/.exec(String(stored));
  if (!match) return false;
  return timingSafeEqual(await derive(password, match[1]), Buffer.from(match[2], 'hex'));
}
