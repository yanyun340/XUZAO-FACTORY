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
describe('库存幂等与失败回滚（R25F）', () => {
  // 前面的并发用例会把库存扣到 0；这里直接补一笔，避免幂等用例受执行顺序影响。
  beforeAll(async () => {
    const inventory = await prisma.partInventory.findFirstOrThrow({ where: { partId: fx.partId } });
    await prisma.partInventory.update({
      where: { id: inventory.id },
      data: { quantity: 500 },
    });
  });

  it('同键同体重放只扣一次，返回首次结果', async () => {
    const id = await partInventoryId();
    const before = await partQuantity();
    const key = 'inv-replay-key-0001';
    const body = { delta: -2, reason: '幂等扣减' };

    const first = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, body, {
      'idempotency-key': key,
    });
    expect(first.status).toBe(200);
    expect(first.body.data.after).toBe(before - 2);

    const replay = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, body, {
      'idempotency-key': key,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.after).toBe(before - 2);

    expect(await partQuantity()).toBe(before - 2);

    const logs = await prisma.inventoryLog.count({ where: { reason: '幂等扣减' } });
    expect(logs).toBe(1);
  });

  it('同键不同请求体被拒绝，不会复用旧结果', async () => {
    const id = await partInventoryId();
    const key = 'inv-reuse-key-0001';
    await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, { delta: -1, reason: '第一次' }, {
      'idempotency-key': key,
    });

    const reused = await admin(
      'POST',
      `/api/v1/inventory/parts/${id}/adjust`,
      { delta: -3, reason: '换了数量' },
      { 'idempotency-key': key },
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('同键指向另一个库存资源也视为不同意图', async () => {
    const second = await prisma.part.create({
      data: { code: 'PRT-IDEM-2', name: '另一个配件', spec: 'S2', inventory: { create: { quantity: 10 } } },
    });
    const secondInventory = await prisma.partInventory.findFirstOrThrow({
      where: { partId: second.id },
    });
    const first = await partInventoryId();
    const key = 'inv-cross-resource-0001';

    const a = await admin('POST', `/api/v1/inventory/parts/${first}/adjust`, {
      delta: -1,
      reason: '资源 A',
    }, { 'idempotency-key': key });
    expect(a.status).toBe(200);

    const b = await admin('POST', `/api/v1/inventory/parts/${secondInventory.id}/adjust`, {
      delta: -1,
      reason: '资源 B',
    }, { 'idempotency-key': key });
    expect(b.status).toBe(409);
    expect(b.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('业务失败时不留下流水、审计或已完成的幂等记录', async () => {
    const id = await partInventoryId();
    const before = await partQuantity();
    const key = 'inv-fail-key-0001';

    const failed = await admin('POST', `/api/v1/inventory/parts/${id}/adjust`, {
      delta: -999999,
      reason: '故意失败',
    }, { 'idempotency-key': key });
    expect(failed.status).toBe(409);
    expect(failed.body.error?.code).toBe('INSUFFICIENT_STOCK');

    expect(await partQuantity()).toBe(before);
    expect(await prisma.inventoryLog.count({ where: { reason: '故意失败' } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'inventory.part.adjust', afterJson: { path: ['reason'], equals: '故意失败' } },
      }),
    ).toBe(0);
    expect(
      await prisma.idempotencyRequest.count({ where: { key, status: 'COMPLETED' } }),
    ).toBe(0);
  });

  it('并发同键只有一个有效扣减', async () => {
    const id = await partInventoryId();
    const before = await partQuantity();
    const key = 'inv-concurrent-key-0001';
    const body = { delta: -2, reason: '并发同键' };

    const [a, b] = await Promise.all([
      admin('POST', `/api/v1/inventory/parts/${id}/adjust`, body, { 'idempotency-key': key }),
      admin('POST', `/api/v1/inventory/parts/${id}/adjust`, body, { 'idempotency-key': key }),
    ]);

    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);
    expect(await partQuantity()).toBe(before - 2);
    expect(await prisma.inventoryLog.count({ where: { reason: '并发同键' } })).toBe(1);
  });
});
