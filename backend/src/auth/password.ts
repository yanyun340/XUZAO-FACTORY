import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * 存储格式：scrypt$N$r$p$saltBase64$hashBase64
 * 参数随哈希一起保存，将来调高强度时旧密码仍可验证。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scrypt(password, salt, KEY_LENGTH, PARAMS)) as Buffer;
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = (await scrypt(password, salt, expected.length, { N: n, r, p })) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * 用户不存在时也跑一次同强度 scrypt，避免通过响应时间枚举用户名。
 */
export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  PARAMS.N,
  PARAMS.r,
  PARAMS.p,
  Buffer.alloc(SALT_LENGTH).toString('base64'),
  Buffer.alloc(KEY_LENGTH).toString('base64'),
].join('$');