import type { Prisma } from '../generated/prisma/client.ts';
import { Errors } from '../errors.ts';

type Db = Prisma.TransactionClient;

export interface ProductIdentity {
  productName: string;
  spec: string;
}

/** 商品库存以「名称 + 规格」为唯一身份，避免同名不同规格被合并。 */
export function productKeyOf(identity: ProductIdentity): string {
  return `${identity.productName.trim().toLowerCase()}|${identity.spec.trim().toLowerCase()}`;
}

/**
 * 订单里出现过的产品自动登记到商品库存台账（初始数量 0）。
 * 这样库存页能搜到全部在产/在售产品，数量仍只由人工调整产生。
 */
export async function ensureProductInventories(
  tx: Db,
  items: ProductIdentity[],
): Promise<void> {
  const seen = new Set<string>();
  for (const item of items) {
    const productKey = productKeyOf(item);
    if (seen.has(productKey)) continue;
    seen.add(productKey);

    await tx.productInventory.upsert({
      where: { productKey },
      update: {},
      create: {
        productKey,
        productName: item.productName.trim(),
        spec: item.spec.trim(),
      },
    });
  }
}

export interface AdjustInput {
  delta: number;
  reason: string;
  operatorId: string;
}

/**
 * 原子调整库存：
 * UPDATE ... WHERE quantity + delta >= 0 RETURNING quantity
 * 判断与写入在同一条语句内完成，并发调整不会出现负库存或丢失更新。
 */
export async function adjustPartStock(
  tx: Db,
  partId: string,
  input: AdjustInput,
): Promise<{ before: number; after: number; version: number }> {
  const rows = await tx.$queryRaw<
    Array<{ quantity: number; version: number; partId: string }>
  >`
    UPDATE "part_inventories"
       SET "quantity" = "quantity" + ${input.delta},
           "version" = "version" + 1,
           "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "id" = ${partId}::uuid
       AND "quantity" + ${input.delta} >= 0
    RETURNING "quantity", "version", "partId"`;

  const row = rows[0];
  if (!row) {
    const existing = await tx.partInventory.findUnique({ where: { id: partId } });
    if (!existing) throw Errors.notFound('配件库存不存在', 'PART_INVENTORY_NOT_FOUND');
    throw Errors.conflict('INSUFFICIENT_STOCK', '库存不足，不能扣减到负数');
  }

  const after = Number(row.quantity);
  await tx.inventoryLog.create({
    data: {
      kind: 'PART',
      partId: row.partId,
      before: after - input.delta,
      delta: input.delta,
      after,
      reason: input.reason,
      operatorId: input.operatorId,
    },
  });

  return { before: after - input.delta, after, version: Number(row.version) };
}

export async function adjustProductStock(
  tx: Db,
  productInventoryId: string,
  input: AdjustInput,
): Promise<{ before: number; after: number; version: number }> {
  const rows = await tx.$queryRaw<Array<{ quantity: number; version: number }>>`
    UPDATE "product_inventories"
       SET "quantity" = "quantity" + ${input.delta},
           "version" = "version" + 1,
           "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "id" = ${productInventoryId}::uuid
       AND "quantity" + ${input.delta} >= 0
    RETURNING "quantity", "version"`;

  const row = rows[0];
  if (!row) {
    const existing = await tx.productInventory.findUnique({ where: { id: productInventoryId } });
    if (!existing) throw Errors.notFound('商品库存不存在', 'PRODUCT_INVENTORY_NOT_FOUND');
    throw Errors.conflict('INSUFFICIENT_STOCK', '库存不足，不能扣减到负数');
  }

  const after = Number(row.quantity);
  await tx.inventoryLog.create({
    data: {
      kind: 'PRODUCT',
      productInventoryId,
      before: after - input.delta,
      delta: input.delta,
      after,
      reason: input.reason,
      operatorId: input.operatorId,
    },
  });

  return { before: after - input.delta, after, version: Number(row.version) };
}