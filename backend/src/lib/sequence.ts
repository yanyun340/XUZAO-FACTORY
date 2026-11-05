import type { Prisma } from '../generated/prisma/client.ts';

type Db = Prisma.TransactionClient;

/**
 * 用单条 upsert 原子取号。
 * 并发请求由 PostgreSQL 的行锁串行化，不会出现两张订单拿到同一个号。
 */
export async function nextSequence(tx: Db, name: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "sequence_counters" ("name", "value")
    VALUES (${name}, 1)
    ON CONFLICT ("name")
    DO UPDATE SET "value" = "sequence_counters"."value" + 1
    RETURNING "value"
  `;

  const value = Number(rows[0]?.value ?? 0);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`取号失败：${name}`);
  }
  return value;
}

export async function nextCode(
  tx: Db,
  kind: string,
  prefix: string,
  width = 4,
): Promise<string> {
  const value = await nextSequence(tx, kind);
  return `${prefix}-${String(value).padStart(width, '0')}`;
}