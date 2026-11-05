import type { PrismaClient } from '../generated/prisma/client.ts';

/**
 * 演示数据里的编码是写死的（CUS-0001 …），而自动取号用的是 sequence_counters。
 * 如果不同步，新建第一条客户就会撞上种子数据的编码。
 * 这里把每个前缀对应的计数器抬到"现有最大编号"，只升不降。
 */
const CODE_KINDS = [
  { kind: 'customer', prefix: 'CUS-', table: 'customers' },
  { kind: 'supplier', prefix: 'SUP-', table: 'suppliers' },
  { kind: 'part', prefix: 'PRT-', table: 'parts' },
  { kind: 'employee', prefix: 'EMP-', table: 'employees' },
] as const;

export async function syncCodeSequences(
  db: PrismaClient,
): Promise<Array<{ kind: string; value: number }>> {
  const result: Array<{ kind: string; value: number }> = [];

  for (const { kind, prefix, table } of CODE_KINDS) {
    const rows = await db.$queryRawUnsafe<Array<{ code: string }>>(`SELECT "code" FROM "${table}"`);

    let max = 0;
    for (const row of rows) {
      if (!row.code.startsWith(prefix)) continue;
      const value = Number(row.code.slice(prefix.length));
      if (Number.isInteger(value) && value > max) max = value;
    }
    if (max === 0) continue;

    await db.$executeRaw`
      INSERT INTO "sequence_counters" ("name", "value")
      VALUES (${kind}, ${max})
      ON CONFLICT ("name")
      DO UPDATE SET "value" = GREATEST("sequence_counters"."value", EXCLUDED."value")
    `;
    result.push({ kind, value: max });
  }

  return result;
}