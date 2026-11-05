import { createHash } from 'node:crypto';

/** 键排序后的 JSON，保证同一请求体得到同一个哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}