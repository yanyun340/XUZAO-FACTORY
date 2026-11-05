import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
});

afterAll(async () => {
  await app.close();
});

async function partInventoryId(): Promise<string> {
  const inventory = await prisma.partInventory.findFirstOrThrow({ where: { partId: fx.partId } });
  return inventory.id;
}

async function partQuantity(): Promise<number> {
  const inventory = await prisma.partInventory.findFirstOrThrow({ where: { partId: fx.partId } });
  return inventory.quantity;
}

describe('配件库存', () => {
  it('入库增加数量并记录流水', async () => {
    const id = await partInventoryId();
    const response = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, {
      delta: 50,
      reason: '盘点补库',
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ before: 100, after: 150 });
    expect(await partQuantity()).toBe(150);

    const logs = await admin('GET', '/api/v1/inventory/logs?kind=PART&pageSize=10');
    expect(logs.status).toBe(200);
    const row = logs.body.data.find((item: { reason: string }) => item.reason === '盘点补库');
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ before: 100, delta: 50, after: 150 });
    expect(row.operatorName).toBe('管理员');
  });

  it('扣减到负数被拒绝，库存保持不变', async () => {
    const id = await partInventoryId();
    const response = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, {
      delta: -500,
      reason: '异常出库',
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('INSUFFICIENT_STOCK');
    expect(await partQuantity()).toBe(150);
  });

  it('调整数量为 0 或原因为空会被校验拦下', async () => {
    const id = await partInventoryId();
    const zero = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, {
      delta: 0,
      reason: '占位',
    });
    expect(zero.status).toBe(400);
    expect(zero.body.error?.code).toBe('VALIDATION_ERROR');

    const shortReason = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, {
      delta: 1,
      reason: 'x',
    });
    expect(shortReason.status).toBe(400);
  });

  it('现场角色不能调整库存', async () => {
    const id = await partInventoryId();
    const caller = api(app, await login(app, 'logistics'));
    const response = await caller('POST', `/api/v1/inventory/parts/${id}/adjust`, {
      delta: 1,
      reason: '越权尝试',
    });
    expect(response.status).toBe(403);
  });

  it('并发扣减不会出现负库存或丢更新', async () => {
    // 当前 150，20 个并发各扣 10：只能成功 15 次，最终恰好 0。
    const id = await partInventoryId();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        admin('POST', `/api/v1/inventory/parts/${id}/adjust`, {
          delta: -10,
          reason: '并发出库',
        }),
      ),
    );

    const okCount = results.filter((result) => result.status === 200).length;
    const conflictCount = results.filter((result) => result.status === 409).length;
    expect(okCount).toBe(15);
    expect(conflictCount).toBe(5);
    expect(await partQuantity()).toBe(0);

    const logs = await prisma.inventoryLog.count({
      where: { partId: fx.partId, kind: 'PART', reason: '并发出库' },
    });
    expect(logs).toBe(15);
  });
});

describe('商品库存', () => {
  it('建档后可用同规格唯一键查到，重复建档返回 409', async () => {
    const created = await admin('POST', '/api/v1/inventory/products', {
      productName: '不锈钢法兰组件',
      spec: 'DN50',
      quantity: 10,
      reason: '期初建档',
    });
    expect(created.status).toBe(201);

    const duplicate = await admin('POST', '/api/v1/inventory/products', {
      productName: ' 不锈钢法兰组件 ',
      spec: 'dn50',
      quantity: 1,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe('PRODUCT_ALREADY_EXISTS');

    const list = await admin('GET', '/api/v1/inventory/products?keyword=法兰');
    expect(list.status).toBe(200);
    expect(list.body.data.some((item: { id: string }) => item.id === created.body.data.id)).toBe(true);
  });

  it('并发首次建档只落一条记录，其余返回同一种冲突', async () => {
    // 先查后建在并发下会同时通过检查，唯一键负责兜底；客户端应只看到稳定的 409。
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        admin('POST', '/api/v1/inventory/products', {
          productName: '并发建档产品',
          spec: 'C-01',
          quantity: 0,
        }),
      ),
    );

    const created = results.filter((result) => result.status === 201);
    const conflicts = results.filter((result) => result.status !== 201);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(7);
    for (const conflict of conflicts) {
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe('PRODUCT_ALREADY_EXISTS');
    }

    const rows = await prisma.productInventory.count({
      where: { productKey: '并发建档产品|c-01' },
    });
    expect(rows).toBe(1);
  });

  it('商品库存同样不能扣成负数', async () => {
    const created = await admin('POST', '/api/v1/inventory/products', {
      productName: '测试商品',
      spec: 'A1',
      quantity: 3,
    });
    expect(created.status).toBe(201);

    const failed = await admin('POST', `/api/v1/inventory/products/${created.body.data.id}/adjust`, {
      delta: -4,
      reason: '超量出库',
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error?.code).toBe('INSUFFICIENT_STOCK');

    const success = await admin('POST', `/api/v1/inventory/products/${created.body.data.id}/adjust`, {
      delta: -3,
      reason: '正常出库',
    });
    expect(success.status).toBe(200);
    expect(success.body.data).toMatchObject({ before: 3, after: 0 });
  });
});