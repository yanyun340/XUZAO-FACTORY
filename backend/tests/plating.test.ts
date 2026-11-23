import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import {
  api,
  createApp,
  login,
  resetDb,
  seedBase,
  type Fixtures,
} from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;
let logistics: ReturnType<typeof api>;
let production: ReturnType<typeof api>;
let qcUser: ReturnType<typeof api>;
let platingSupplierId: string;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
  logistics = api(app, await login(app, 'logistics'));
  production = api(app, await login(app, 'production'));
  qcUser = api(app, await login(app, 'qc'));

  const supplier = await admin('POST', '/api/v1/suppliers', {
    name: '测试电镀厂',
    type: 'ELECTROPLATING',
  });
  expect(supplier.status).toBe(201);
  platingSupplierId = supplier.body.data.id;
});

afterAll(async () => {
  await app.close();
});

async function createOrderWithPurchase(platingRequired: boolean) {
  const order = await admin('POST', '/api/v1/orders', {
    customerId: fx.customerId,
    dueDate: '2026-12-31',
    items: [{ productName: '电镀测试件', spec: 'P-01', quantity: 100, unitPrice: '12.50' }],
  });
  expect(order.status).toBe(201);
  const orderId = order.body.data.id as string;

  const purchase = await admin('POST', `/api/v1/orders/${orderId}/purchase`, {
    supplierId: fx.supplierId,
    partId: fx.partId,
    quantity: 100,
    unitPrice: '5.00',
    platingRequired,
  });
  expect(purchase.status).toBe(201);

  const arrival = await logistics(
    'POST',
    `/api/v1/purchases/${purchase.body.data.flow.purchase.id}/arrivals`,
    { quantity: 100 },
  );
  expect(arrival.status).toBe(201);

  const detail = await admin('GET', `/api/v1/orders/${orderId}`);
  return {
    orderId,
    purchaseItemId: detail.body.data.flow.purchase.items[0].id as string,
  };
}

describe('电镀外协（R06F）', () => {
  it('管理员为已到货的需电镀采购项建单，按整件计价', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);

    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    expect(created.status).toBe(201);
    const plating = created.body.data.flow.plating;
    expect(plating.required).toBe(true);
    expect(plating.notApplicable).toBe(false);
    expect(plating.orders[0]).toMatchObject({
      quantity: 20,
      supplierName: '测试电镀厂',
      status: 'PENDING',
      amount: '50.00',
    });
    expect(created.body.data.flow.profit.platingCost).toBe('0.00');
  });

  it('超过已到货可电镀余量被拒绝', async () => {
    const { orderId } = await createOrderWithPurchase(true);
    const detail = await admin('GET', `/api/v1/orders/${orderId}`);
    const itemId = detail.body.data.flow.purchase.items[0].id;

    const first = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId: itemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    expect(first.status).toBe(201);

    const over = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId: itemId,
      supplierId: platingSupplierId,
      quantity: 90,
      unitPrice: '2.50',
    });
    expect(over.status).toBe(422);
    expect(over.body.error?.code).toBe('PLATING_EXCEEDS_REMAINING');
  });

  it('发送前可改数量，发送后改删都被拒绝', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);
    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    const platingId = created.body.data.flow.plating.orders[0].id as string;

    const updated = await admin('PATCH', `/api/v1/plating-orders/${platingId}`, {
      quantity: 25,
      unitPrice: '2.40',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.flow.plating.orders[0]).toMatchObject({
      quantity: 25,
      unitPrice: '2.40',
    });

    const sent = await logistics('POST', `/api/v1/plating-orders/${platingId}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.data.flow.plating.orders[0].status).toBe('SENT');

    const editLocked = await admin('PATCH', `/api/v1/plating-orders/${platingId}`, {
      quantity: 10,
    });
    expect(editLocked.status).toBe(409);
    expect(editLocked.body.error?.code).toBe('PLATING_LOCKED');

    const deleteLocked = await admin('DELETE', `/api/v1/plating-orders/${platingId}`);
    expect(deleteLocked.status).toBe(409);
  });

  it('跳过发送直接收货被拒绝；发送与收货幂等', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);
    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    const platingId = created.body.data.flow.plating.orders[0].id as string;

    const early = await logistics('POST', `/api/v1/plating-orders/${platingId}/receive`);
    expect(early.status).toBe(409);
    expect(early.body.error?.code).toBe('PLATING_NOT_SENT');

    const key = 'plating-send-key-0001';
    const first = await logistics('POST', `/api/v1/plating-orders/${platingId}/send`, undefined, {
      'idempotency-key': key,
    });
    expect(first.status).toBe(200);
    const replay = await logistics('POST', `/api/v1/plating-orders/${platingId}/send`, undefined, {
      'idempotency-key': key,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const again = await logistics('POST', `/api/v1/plating-orders/${platingId}/send`);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('PLATING_ALREADY_SENT');

    const received = await logistics('POST', `/api/v1/plating-orders/${platingId}/receive`);
    expect(received.status).toBe(200);
    expect(received.body.data.flow.plating.orders[0].status).toBe('RECEIVED');

    const receivedAgain = await logistics('POST', `/api/v1/plating-orders/${platingId}/receive`);
    expect(receivedAgain.status).toBe(409);
    expect(receivedAgain.body.error?.code).toBe('PLATING_ALREADY_RECEIVED');
  });

  it('未电镀收货不能下发生产；部分收货只能生产已收数量', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);
    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    const platingId = created.body.data.flow.plating.orders[0].id as string;

    const blocked = await admin('POST', `/api/v1/orders/${orderId}/productions`, {
      departmentId: fx.departments.PROD,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error?.code).toBe('PLATING_NOT_RECEIVED');

    await logistics('POST', `/api/v1/plating-orders/${platingId}/send`);
    await logistics('POST', `/api/v1/plating-orders/${platingId}/receive`);

    const tooMany = await admin('POST', `/api/v1/orders/${orderId}/productions`, {
      departmentId: fx.departments.PROD,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
    });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error?.code).toBe('PLATING_QTY_INSUFFICIENT');

    const allowed = await admin('POST', `/api/v1/orders/${orderId}/productions`, {
      departmentId: fx.departments.PROD,
      processName: '车削',
      quantity: 20,
      unitPrice: '2.00',
    });
    expect(allowed.status).toBe(201);
  });

  it('不需电镀的订单显示不适用，生产不受影响', async () => {
    const { orderId } = await createOrderWithPurchase(false);
    const detail = await admin('GET', `/api/v1/orders/${orderId}`);
    expect(detail.body.data.flow.plating).toMatchObject({
      required: false,
      notApplicable: true,
      orders: [],
    });

    const dispatched = await admin('POST', `/api/v1/orders/${orderId}/productions`, {
      departmentId: fx.departments.PROD,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
    });
    expect(dispatched.status).toBe(201);

    const events = await prisma.timelineEvent.count({
      where: { orderId, type: { startsWith: 'PLATING_' } },
    });
    expect(events).toBe(0);
  });

  it('电镀厂商类型与角色边界', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);

    const wrongType = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: fx.supplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body.error?.code).toBe('PLATING_SUPPLIER_REQUIRED');

    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    const platingId = created.body.data.flow.plating.orders[0].id as string;

    const adminSend = await admin('POST', `/api/v1/plating-orders/${platingId}/send`);
    expect(adminSend.status).toBe(403);
    const qcSend = await qcUser('POST', `/api/v1/plating-orders/${platingId}/send`);
    expect(qcSend.status).toBe(403);
    const productionSend = await production('POST', `/api/v1/plating-orders/${platingId}/send`);
    expect(productionSend.status).toBe(403);
  });

  it('物流待办会提示发送/收货电镀，不要求进订单详情找按钮', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);
    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    const platingId = created.body.data.flow.plating.orders[0].id as string;

    const pendingTasks = await logistics('GET', '/api/v1/tasks');
    expect(pendingTasks.status).toBe(200);
    const sendTask = pendingTasks.body.data.find(
      (task: { id: string }) => task.id === orderId,
    );
    expect(sendTask?.action).toBe('send-plating');

    await logistics('POST', `/api/v1/plating-orders/${platingId}/send`);
    const sentTasks = await logistics('GET', '/api/v1/tasks');
    const receiveTask = sentTasks.body.data.find(
      (task: { id: string }) => task.id === orderId,
    );
    expect(receiveTask?.action).toBe('receive-plating');

    await logistics('POST', `/api/v1/plating-orders/${platingId}/receive`);
    const doneTasks = await logistics('GET', '/api/v1/tasks');
    expect(doneTasks.body.data.some((task: { id: string }) => task.id === orderId)).toBe(false);
  });

  it('电镀费用计入利润与看板', async () => {
    const { orderId, purchaseItemId } = await createOrderWithPurchase(true);
    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplierId,
      quantity: 20,
      unitPrice: '2.50',
    });
    const platingId = created.body.data.flow.plating.orders[0].id as string;
    await logistics('POST', `/api/v1/plating-orders/${platingId}/send`);
    await logistics('POST', `/api/v1/plating-orders/${platingId}/receive`);

    const detail = await admin('GET', `/api/v1/orders/${orderId}`);
    expect(detail.body.data.flow.profit.platingCost).toBe('50.00');
    // 销售 100×12.50=1250，采购 100×5=500，电镀 20×2.50=50
    expect(detail.body.data.flow.profit.profit).toBe('700.00');

    const dashboard = await admin('GET', '/api/v1/dashboard');
    expect(dashboard.status).toBe(200);
    expect(Number(dashboard.body.data.profit.platingCost)).toBeGreaterThanOrEqual(50);
  });
});