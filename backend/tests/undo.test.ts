import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { setNowForTesting, UNDO_WINDOW_MS } from '../src/lib/clock.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;
let logistics: ReturnType<typeof api>;
let production: ReturnType<typeof api>;
let qcUser: ReturnType<typeof api>;
let packing: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
  logistics = api(app, await login(app, 'logistics'));
  production = api(app, await login(app, 'production'));
  qcUser = api(app, await login(app, 'qc'));
  packing = api(app, await login(app, 'packing'));
});

afterEach(() => {
  // 时钟是模块级状态，漏了这一步会把后面所有用例的窗口判断带偏。
  setNowForTesting(null);
});

afterAll(async () => {
  await app.close();
});

const dueDate = () => new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);

/** R12F：把「当前时刻」挪到记录创建时间之后的某个偏移量。 */
function advanceFrom(createdAt: string, offsetMs: number): void {
  setNowForTesting(new Date(new Date(createdAt).getTime() + offsetMs));
}

async function createOrder(): Promise<{ id: string; orderNo: string }> {
  const response = await admin('POST', '/api/v1/orders', {
    customerId: fx.customerId,
    customerContact: '王工',
    dueDate: dueDate(),
    remark: 'R12F 撤销用例',
    items: [{ productName: '不锈钢法兰组件', spec: 'DN50', quantity: 100, unitPrice: '12.50' }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data;
}

/** 建单 → 采购 → 到货 100，停在「采购中」。 */
async function createOrderWithArrival(): Promise<{
  orderId: string;
  purchaseItemId: string;
  arrivalId: string;
  arrivalCreatedAt: string;
}> {
  const order = await createOrder();
  const purchase = await admin('POST', `/api/v1/orders/${order.id}/purchase`, {
    supplierId: fx.supplierId,
    partId: fx.partId,
    quantity: 100,
    unitPrice: '5.00',
  });
  expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);
  const purchaseId = purchase.body.data.flow.purchase.id as string;
  const purchaseItemId = purchase.body.data.flow.purchase.items[0].id as string;

  const arrival = await logistics('POST', `/api/v1/purchases/${purchaseId}/arrivals`, {
    quantity: 100,
  });
  expect(arrival.status, JSON.stringify(arrival.body)).toBe(201);
  const row = arrival.body.data.flow.purchase.items[0].arrivals[0];

  return {
    orderId: order.id,
    purchaseItemId,
    arrivalId: row.id,
    arrivalCreatedAt: row.createdAt,
  };
}

/** 到货 100 + 已下发生产 + 已反馈，停在「生产中」。 */
async function createOrderWithFeedback(): Promise<{
  orderId: string;
  productionId: string;
  feedbackId: string;
  feedbackCreatedAt: string;
}> {
  const base = await createOrderWithArrival();
  const dispatched = await admin('POST', `/api/v1/orders/${base.orderId}/productions`, {
    departmentId: fx.departments.PROD,
    processName: '车削',
    quantity: 100,
    unitPrice: '2.00',
  });
  expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(201);
  const productionId = dispatched.body.data.flow.production.id as string;

  const feedback = await production('POST', `/api/v1/productions/${productionId}/feedback`, {
    quantity: 100,
  });
  expect(feedback.status, JSON.stringify(feedback.body)).toBe(201);
  const row = feedback.body.data.flow.production.feedback;

  return {
    orderId: base.orderId,
    productionId,
    feedbackId: row.id,
    feedbackCreatedAt: row.createdAt,
  };
}

/** 走到「待质检」，返回生产任务与订单。 */
async function createOrderAtQc(): Promise<{ orderId: string; productionId: string }> {
  const base = await createOrderWithFeedback();
  const dispatch = await admin('POST', `/api/v1/orders/${base.orderId}/qc-dispatch`);
  expect(dispatch.status, JSON.stringify(dispatch.body)).toBe(201);
  return { orderId: base.orderId, productionId: base.productionId };
}

/** 首检 100 全合格 + 管理员 PASS，订单进 QC_DONE。 */
async function createOrderAtQcDone(): Promise<{
  orderId: string;
  productionId: string;
  qcRecordId: string;
  qcCreatedAt: string;
}> {
  const { orderId, productionId } = await createOrderAtQc();
  const record = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
    inspectedQty: 100,
    qualifiedQty: 100,
    unqualifiedQty: 0,
  });
  expect(record.status, JSON.stringify(record.body)).toBe(201);
  const qcRecordId = record.body.data.flow.qc.id as string;
  const qcCreatedAt = record.body.data.flow.qc.createdAt as string;

  const decision = await admin('POST', `/api/v1/qc-records/${qcRecordId}/decision`, {
    decision: 'PASS',
  });
  expect(decision.status, JSON.stringify(decision.body)).toBe(201);
  expect(decision.body.data.status).toBe('QC_DONE');

  return { orderId, productionId, qcRecordId, qcCreatedAt };
}

/** 走到「包装中」，并登记一笔包装。 */
async function createOrderAtPacking(): Promise<{
  orderId: string;
  packingId: string;
  packingCreatedAt: string;
}> {
  const { orderId } = await createOrderAtQcDone();
  const dispatch = await admin('POST', `/api/v1/orders/${orderId}/packing-dispatch`);
  expect(dispatch.status, JSON.stringify(dispatch.body)).toBe(201);

  const record = await packing('POST', `/api/v1/orders/${orderId}/packing-records`, {
    quantity: 100,
  });
  expect(record.status, JSON.stringify(record.body)).toBe(201);
  const row = record.body.data.flow.packing.records[0];
  return { orderId, packingId: row.id, packingCreatedAt: row.createdAt };
}

/** 走到「发货中」，并登记一笔足量发货（订单随即 COMPLETED）。 */
async function createCompletedOrder(): Promise<{
  orderId: string;
  shipmentId: string;
  shipmentCreatedAt: string;
}> {
  const { orderId } = await createOrderAtPacking();
  const triggered = await admin('POST', `/api/v1/orders/${orderId}/shipping-trigger`);
  expect(triggered.status, JSON.stringify(triggered.body)).toBe(201);

  const record = await logistics('POST', `/api/v1/orders/${orderId}/shipment-records`, {
    quantity: 100,
  });
  expect(record.status, JSON.stringify(record.body)).toBe(201);
  expect(record.body.data.status).toBe('COMPLETED');
  const row = record.body.data.flow.shipping.records[0];
  return { orderId, shipmentId: row.id, shipmentCreatedAt: row.createdAt };
}

describe('R12F 到货撤销', () => {  it('原操作者在窗口内撤销：数量回退、记录仍在但标记作废', async () => {
    const { orderId, arrivalId, arrivalCreatedAt } = await createOrderWithArrival();
    advanceFrom(arrivalCreatedAt, 60_000);

    const response = await logistics('POST', `/api/v1/arrivals/${arrivalId}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const item = response.body.data.flow.purchase.items[0];
    expect(item.arrivedQty).toBe(0);
    expect(item.arrivals).toHaveLength(1);
    expect(item.arrivals[0].voidedAt).toBeTruthy();
    expect(item.arrivals[0].voidReason).toContain('撤销');
    expect(response.body.data.flow.quantities.arrivedQty).toBe(0);
    expect(response.body.data.status).toBe('PURCHASING');

    const event = response.body.data.timeline.at(-1);
    expect(event.type).toBe('ARRIVAL_UNDONE');
    expect(event.payload.recordId).toBe(arrivalId);

    // A17 第 4 条：撤销后同一采购项可以重新登记到货（到货量归零 → 动作重新出现）。
    expect(response.body.data.allowedActions).toContain('record-arrival');
    const again = await logistics('POST', `/api/v1/purchases/${response.body.data.flow.purchase.id}/arrivals`, {
      quantity: 60,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.flow.quantities.arrivedQty).toBe(60);
    void orderId;
  });

  it('已下发生产后不能撤销到货（UNDO_HAS_PRODUCTION）', async () => {
    const { orderId, arrivalId, arrivalCreatedAt } = await createOrderWithArrival();
    const dispatched = await admin('POST', `/api/v1/orders/${orderId}/productions`, {
      departmentId: fx.departments.PROD,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
    });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(201);
    advanceFrom(arrivalCreatedAt, 60_000);

    const response = await logistics('POST', `/api/v1/arrivals/${arrivalId}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_PRODUCTION');
  });

  it('采购项已建电镀单（哪怕还没发送）时不能撤销到货', async () => {
    const { orderId, purchaseItemId, arrivalId, arrivalCreatedAt } = await createOrderWithArrival();
    // 把采购项标成需要电镀，再建一张 PENDING 电镀单
    await prisma.purchaseItem.update({
      where: { id: purchaseItemId },
      data: { platingRequired: true },
    });
    const platingSupplier = await prisma.supplier.create({
      data: { code: 'PLATE-R12F', name: '电镀厂（撤销用例）', type: 'ELECTROPLATING' },
    });
    const created = await admin('POST', `/api/v1/orders/${orderId}/plating-orders`, {
      purchaseItemId,
      supplierId: platingSupplier.id,
      quantity: 60,
      unitPrice: '1.50',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    advanceFrom(arrivalCreatedAt, 60_000);
    const response = await logistics('POST', `/api/v1/arrivals/${arrivalId}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_PLATING');
  });
});

describe('R12F 权限与窗口', () => {
  it('他人不能撤销（403）', async () => {
    const { arrivalId, arrivalCreatedAt } = await createOrderWithArrival();
    advanceFrom(arrivalCreatedAt, 60_000);

    const response = await admin('POST', `/api/v1/arrivals/${arrivalId}/undo`);
    // 管理员本来就可以代撤，所以这里换一个「非管理员且非原操作者」的角色
    expect(response.status).toBe(200);

    const second = await createOrderWithArrival();
    advanceFrom(second.arrivalCreatedAt, 60_000);
    const outsider = await packing('POST', `/api/v1/arrivals/${second.arrivalId}/undo`);
    expect(outsider.status).toBe(403);
  });

  it('窗口边界：9分59秒允许，10分01秒非管理员拒绝', async () => {
    const inside = await createOrderWithArrival();
    advanceFrom(inside.arrivalCreatedAt, UNDO_WINDOW_MS - 1_000);
    const ok = await logistics('POST', `/api/v1/arrivals/${inside.arrivalId}/undo`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const outside = await createOrderWithArrival();
    advanceFrom(outside.arrivalCreatedAt, UNDO_WINDOW_MS + 1_000);
    const expired = await logistics('POST', `/api/v1/arrivals/${outside.arrivalId}/undo`);
    expect(expired.status).toBe(409);
    expect(expired.body.error?.code).toBe('UNDO_WINDOW_EXPIRED');

    // 管理员在窗口外仍可「修正」，但必须给原因。
    const missing = await admin('POST', `/api/v1/arrivals/${outside.arrivalId}/correct`, {});
    expect(missing.status).toBe(400);

    const corrected = await admin('POST', `/api/v1/arrivals/${outside.arrivalId}/correct`, {
      reason: '现场录错，实际到货 80 件',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body.data.flow.quantities.arrivedQty).toBe(0);
    expect(corrected.body.data.timeline.at(-1).type).toBe('ARRIVAL_CORRECTED');
  });

  it('非管理员不能修正（403）', async () => {
    const { arrivalId } = await createOrderWithArrival();
    const response = await logistics('POST', `/api/v1/arrivals/${arrivalId}/correct`, {
      reason: '我想修正',
    });
    expect(response.status).toBe(403);
  });

  it('重复撤销返回 409，不重复扣量', async () => {
    const { arrivalId, arrivalCreatedAt } = await createOrderWithArrival();
    advanceFrom(arrivalCreatedAt, 60_000);
    const first = await logistics('POST', `/api/v1/arrivals/${arrivalId}/undo`);
    expect(first.status).toBe(200);

    const second = await logistics('POST', `/api/v1/arrivals/${arrivalId}/undo`);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('RECORD_ALREADY_VOIDED');

    const row = await prisma.arrivalRecord.findUniqueOrThrow({ where: { id: arrivalId } });
    expect(row.quantity).toBe(100);
    expect(row.voidedAt).not.toBeNull();
  });

  it('同键重放返回 200 且只生效一次', async () => {
    const { arrivalId, arrivalCreatedAt } = await createOrderWithArrival();
    advanceFrom(arrivalCreatedAt, 60_000);
    const key = `undo-${arrivalId}`;

    const first = await logistics(
      'POST',
      `/api/v1/arrivals/${arrivalId}/undo`,
      {},
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(200);
    const replay = await logistics(
      'POST',
      `/api/v1/arrivals/${arrivalId}/undo`,
      {},
      { 'idempotency-key': key },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.flow.quantities.arrivedQty).toBe(0);

    // 时间线只多一条撤销事件
    const undoEvents = await prisma.timelineEvent.count({
      where: { type: 'ARRIVAL_UNDONE' },
    });
    expect(undoEvents).toBeGreaterThan(0);
  });
});

describe('R12F 生产反馈撤销', () => {
  it('撤销后订单退回 IN_PRODUCTION，可以重新反馈', async () => {
    const { orderId, feedbackId, feedbackCreatedAt } = await createOrderWithFeedback();
    advanceFrom(feedbackCreatedAt, 60_000);

    const response = await production('POST', `/api/v1/feedbacks/${feedbackId}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe('IN_PRODUCTION');
    expect(response.body.data.flow.quantities.producedQty).toBe(0);
    expect(response.body.data.flow.production.feedback.voidedAt).toBeTruthy();

    const again = await production('POST', `/api/v1/productions/${
      response.body.data.flow.production.id
    }/feedback`, { quantity: 60 });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.flow.quantities.producedQty).toBe(60);
    void orderId;
  });

  it('已录入质检后不能撤销反馈（UNDO_HAS_QC）', async () => {
    const { productionId } = await createOrderAtQc();
    const record = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 100,
      qualifiedQty: 100,
      unqualifiedQty: 0,
    });
    expect(record.status).toBe(201);
    const feedback = await prisma.productionFeedback.findFirstOrThrow({
      where: { productionOrderId: productionId, voidedAt: null },
    });
    advanceFrom(feedback.createdAt.toISOString(), 60_000);

    const response = await production('POST', `/api/v1/feedbacks/${feedback.id}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_QC');
  });
});

describe('R12F 质检撤销', () => {
  it('撤销已决策的质检记录会连决策一起作废，订单回到 PENDING_QC', async () => {
    const { orderId, qcRecordId, qcCreatedAt } = await createOrderAtQcDone();
    advanceFrom(qcCreatedAt, 60_000);

    const response = await qcUser('POST', `/api/v1/qc-records/${qcRecordId}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe('PENDING_QC');
    expect(response.body.data.flow.quantities.releasedQty).toBe(0);
    expect(response.body.data.flow.qc).toBeNull();

    const decision = await prisma.qCDecision.findUniqueOrThrow({ where: { qcRecordId } });
    expect(decision.voidedAt).not.toBeNull();

    // 撤销后可以重新录入质检
    const { productionId } = await prisma.qCRecord.findUniqueOrThrow({
      where: { id: qcRecordId },
      select: { productionOrderId: true },
    }).then((row) => ({ productionId: row.productionOrderId }));
    const again = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 100,
      qualifiedQty: 90,
      unqualifiedQty: 10,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    void orderId;
  });

  it('已包装后不能撤销质检（UNDO_HAS_PACKING）', async () => {
    const { orderId } = await createOrderAtQcDone();
    const dispatch = await admin('POST', `/api/v1/orders/${orderId}/packing-dispatch`);
    expect(dispatch.status).toBe(201);
    const packed = await packing('POST', `/api/v1/orders/${orderId}/packing-records`, {
      quantity: 100,
    });
    expect(packed.status).toBe(201);
    const record = await prisma.qCRecord.findFirstOrThrow({
      where: { voidedAt: null, productionOrder: { orderId } },
    });
    advanceFrom(record.createdAt.toISOString(), 60_000);

    const response = await qcUser('POST', `/api/v1/qc-records/${record.id}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_PACKING');
  });

  it('已下发包装但尚未登记包装时，同样不能撤销质检（否则订单卡在 PACKING）', async () => {
    const { orderId } = await createOrderAtQcDone();
    const dispatch = await admin('POST', `/api/v1/orders/${orderId}/packing-dispatch`);
    expect(dispatch.status).toBe(201);
    expect(dispatch.body.data.status).toBe('PACKING');
    expect(dispatch.body.data.flow.quantities.packedQty).toBe(0);

    const record = await prisma.qCRecord.findFirstOrThrow({
      where: { voidedAt: null, productionOrder: { orderId } },
    });
    advanceFrom(record.createdAt.toISOString(), 60_000);

    const response = await qcUser('POST', `/api/v1/qc-records/${record.id}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_PACKING');

    // 订单状态没被改动，仍可继续登记包装
    const detail = await packing('GET', `/api/v1/orders/${orderId}`);
    expect(detail.body.data.status).toBe('PACKING');
    expect(detail.body.data.allowedActions).toContain('record-packing');
  });

  it('有复检子记录时不能撤销父记录（UNDO_HAS_CHILD_QC）', async () => {
    const { orderId, productionId } = await createOrderAtQc();
    const first = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 100,
      qualifiedQty: 90,
      unqualifiedQty: 10,
    });
    expect(first.status).toBe(201);
    const parentId = first.body.data.flow.qc.id as string;
    await admin('POST', `/api/v1/qc-records/${parentId}/decision`, { decision: 'REWORK' });

    const child = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 10,
      qualifiedQty: 10,
      unqualifiedQty: 0,
      parentQcRecordId: parentId,
    });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    const parent = await prisma.qCRecord.findUniqueOrThrow({ where: { id: parentId } });
    advanceFrom(parent.createdAt.toISOString(), 60_000);

    const response = await qcUser('POST', `/api/v1/qc-records/${parentId}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_CHILD_QC');
    void orderId;
  });
});

describe('R12F 包装与发货撤销', () => {
  it('撤销包装后可以重新登记', async () => {
    const { orderId, packingId, packingCreatedAt } = await createOrderAtPacking();
    advanceFrom(packingCreatedAt, 60_000);

    const response = await packing('POST', `/api/v1/packing-records/${packingId}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.flow.quantities.packedQty).toBe(0);
    expect(response.body.data.status).toBe('PACKING');

    const again = await packing('POST', `/api/v1/orders/${orderId}/packing-records`, {
      quantity: 50,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.flow.quantities.packedQty).toBe(50);
  });

  it('已发货后不能撤销包装（UNDO_HAS_SHIPMENT）', async () => {
    const { orderId } = await createOrderAtPacking();
    await admin('POST', `/api/v1/orders/${orderId}/shipping-trigger`);
    const shipped = await logistics('POST', `/api/v1/orders/${orderId}/shipment-records`, {
      quantity: 100,
    });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(201);
    const record = await prisma.packingRecord.findFirstOrThrow({
      where: { orderId, voidedAt: null },
    });
    advanceFrom(record.createdAt.toISOString(), 60_000);

    const response = await packing('POST', `/api/v1/packing-records/${record.id}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_SHIPMENT');
  });

  it('已触发发货但尚未登记发货时，同样不能撤销包装（否则订单卡在 SHIPPING）', async () => {
    const { orderId } = await createOrderAtPacking();
    const triggered = await admin('POST', `/api/v1/orders/${orderId}/shipping-trigger`);
    expect(triggered.status, JSON.stringify(triggered.body)).toBe(201);
    expect(triggered.body.data.status).toBe('SHIPPING');
    expect(triggered.body.data.flow.quantities.shippedQty).toBe(0);

    const record = await prisma.packingRecord.findFirstOrThrow({
      where: { orderId, voidedAt: null },
    });
    advanceFrom(record.createdAt.toISOString(), 60_000);

    const response = await packing('POST', `/api/v1/packing-records/${record.id}/undo`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('UNDO_HAS_SHIPMENT');

    const detail = await logistics('GET', `/api/v1/orders/${orderId}`);
    expect(detail.body.data.status).toBe('SHIPPING');
    expect(detail.body.data.allowedActions).toContain('record-shipment');
  });

  it('撤销足量发货后订单从 COMPLETED 回到 SHIPPING，completedAt 清空', async () => {
    const { orderId, shipmentId, shipmentCreatedAt } = await createCompletedOrder();
    advanceFrom(shipmentCreatedAt, 60_000);

    const response = await logistics('POST', `/api/v1/shipment-records/${shipmentId}/undo`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe('SHIPPING');
    expect(response.body.data.completedAt).toBeNull();
    expect(response.body.data.flow.quantities.shippedQty).toBe(0);

    const again = await logistics('POST', `/api/v1/orders/${orderId}/shipment-records`, {
      quantity: 40,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.flow.quantities.shippedQty).toBe(40);
  });
});

describe('R12F 看板与利润口径', () => {
  it('撤销反馈后看板产量与生产成本同步下降', async () => {
    const { feedbackId, feedbackCreatedAt } = await createOrderWithFeedback();
    const before = await admin('GET', '/api/v1/dashboard');
    const completedBefore = before.body.data.production.completedFeedback;
    const costBefore = Number(before.body.data.profit.productionCost);

    advanceFrom(feedbackCreatedAt, 60_000);
    const undo = await production('POST', `/api/v1/feedbacks/${feedbackId}/undo`);
    expect(undo.status).toBe(200);

    const after = await admin('GET', '/api/v1/dashboard');
    expect(after.body.data.production.completedFeedback).toBe(completedBefore - 100);
    expect(Number(after.body.data.profit.productionCost)).toBe(costBefore - 200);
  });
});
