import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;
let logistics: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
  logistics = api(app, await login(app, 'logistics'));
});

afterAll(async () => {
  await app.close();
});

async function createOrder() {
  const response = await admin('POST', '/api/v1/orders', {
    customerId: fx.customerId,
    dueDate: '2026-12-31',
    items: [{ productName: '供应商测试件', spec: 'S-01', quantity: 10, unitPrice: '3.00' }],
  });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

describe('配件多供应商与默认供应商（R02F）', () => {
  it('供应商可以标记为电镀厂商', async () => {
    const created = await admin('POST', '/api/v1/suppliers', {
      name: '电镀测试厂商',
      type: 'ELECTROPLATING',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe('ELECTROPLATING');

    const patched = await admin('PATCH', `/api/v1/suppliers/${created.body.data.id}`, {
      type: 'NORMAL',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.type).toBe('NORMAL');
  });

  it('同一配件只能有一个默认供应商，切换后采购按默认预选', async () => {
    const second = await admin('POST', '/api/v1/suppliers', { name: '第二供应商' });
    expect(second.status).toBe(201);
    const supplierB = second.body.data.id as string;

    const addA = await admin('POST', `/api/v1/parts/${fx.partId}/suppliers`, {
      supplierId: fx.supplierId,
      isDefault: true,
    });
    expect(addA.status).toBe(201);
    expect(addA.body.data.isDefault).toBe(true);

    const addB = await admin('POST', `/api/v1/parts/${fx.partId}/suppliers`, {
      supplierId: supplierB,
      isDefault: false,
    });
    expect(addB.status).toBe(201);

    const list = await admin('GET', `/api/v1/parts/${fx.partId}/suppliers`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((row: { isDefault: boolean }) => row.isDefault)).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ supplierId: fx.supplierId, isDefault: true });

    const switched = await admin(
      'PATCH',
      `/api/v1/parts/${fx.partId}/suppliers/${supplierB}`,
      { isDefault: true },
    );
    expect(switched.status).toBe(200);

    const after = await admin('GET', `/api/v1/parts/${fx.partId}/suppliers`);
    const defaults = after.body.data.filter((row: { isDefault: boolean }) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].supplierId).toBe(supplierB);
  });

  it('采购只能从配件供应商集合中选择，且快照不随默认供应商变化', async () => {
    const orderId = await createOrder();
    const supplierB = await prisma.partSupplier.findFirstOrThrow({
      where: { partId: fx.partId, isDefault: true },
    });

    // 集合存在时，集合外供应商被拒绝
    const outsider = await admin('POST', '/api/v1/suppliers', { name: '集合外供应商' });
    const rejected = await admin('POST', `/api/v1/orders/${orderId}/purchase`, {
      supplierId: outsider.body.data.id,
      partId: fx.partId,
      quantity: 10,
      unitPrice: '1.00',
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error?.code).toBe('SUPPLIER_NOT_IN_PART_SET');

    // 默认供应商可以建采购
    const accepted = await admin('POST', `/api/v1/orders/${orderId}/purchase`, {
      supplierId: supplierB.supplierId,
      partId: fx.partId,
      quantity: 10,
      unitPrice: '1.00',
    });
    expect(accepted.status).toBe(201);
    const purchaseId = accepted.body.data.flow.purchase.id as string;
    const snapshotName = accepted.body.data.flow.purchase.supplierName as string;

    // 把默认切回第一个供应商，历史采购快照不变
    await admin('PATCH', `/api/v1/parts/${fx.partId}/suppliers/${fx.supplierId}`, {
      isDefault: true,
    });
    const purchase = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(purchase.supplierName).toBe(snapshotName);
  });

  it('停用供应商不能加入集合，移除后也不能再采购', async () => {
    const inactive = await admin('POST', '/api/v1/suppliers', {
      name: '待停用供应商',
      type: 'NORMAL',
    });
    await admin('PATCH', `/api/v1/suppliers/${inactive.body.data.id}`, { active: false });

    const rejected = await admin('POST', `/api/v1/parts/${fx.partId}/suppliers`, {
      supplierId: inactive.body.data.id,
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error?.code).toBe('SUPPLIER_NOT_FOUND');

    // 移除当前默认供应商后再建采购会被拒绝
    const currentDefault = await prisma.partSupplier.findFirstOrThrow({
      where: { partId: fx.partId, isDefault: true },
    });
    const removed = await admin(
      'DELETE',
      `/api/v1/parts/${fx.partId}/suppliers/${currentDefault.supplierId}`,
    );
    expect(removed.status).toBe(200);

    const orderId = await createOrder();
    const purchase = await admin('POST', `/api/v1/orders/${orderId}/purchase`, {
      supplierId: currentDefault.supplierId,
      partId: fx.partId,
      quantity: 10,
      unitPrice: '1.00',
    });
    expect(purchase.status).toBe(422);
    expect(purchase.body.error?.code).toBe('SUPPLIER_NOT_IN_PART_SET');
  });

  it('并发设置默认供应商后仍然只有一个默认', async () => {
    const third = await admin('POST', '/api/v1/suppliers', { name: '并发测试供应商' });
    await admin('POST', `/api/v1/parts/${fx.partId}/suppliers`, {
      supplierId: third.body.data.id,
    });

    const rows = await prisma.partSupplier.findMany({ where: { partId: fx.partId } });
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const [a, b] = await Promise.all([
      admin('PATCH', `/api/v1/parts/${fx.partId}/suppliers/${rows[0]!.supplierId}`, {
        isDefault: true,
      }),
      admin('PATCH', `/api/v1/parts/${fx.partId}/suppliers/${rows[1]!.supplierId}`, {
        isDefault: true,
      }),
    ]);
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);

    const defaults = await prisma.partSupplier.count({
      where: { partId: fx.partId, isDefault: true },
    });
    expect(defaults).toBe(1);
  });

  it('现场角色不能维护配件供应商', async () => {
    const forbidden = await logistics('POST', `/api/v1/parts/${fx.partId}/suppliers`, {
      supplierId: fx.supplierId,
    });
    expect(forbidden.status).toBe(403);
  });
});