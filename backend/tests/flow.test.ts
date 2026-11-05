import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.ts';
import { prisma } from '../src/db.ts';
import {
  api,
  createApp,
  login,
  resetDb,
  seedBase,
  TEST_PASSWORD,
  type Fixtures,
} from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;
let logistics: ReturnType<typeof api>;
let production: ReturnType<typeof api>;
let qcUser: ReturnType<typeof api>;
let packing: ReturnType<typeof api>;
let otherProduction: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  // 另一个生产角色账号，挂在非生产部，用来验证"同部门"这道限制
  await prisma.adminUser.create({
    data: {
      username: 'production-other',
      displayName: '外部门生产',
      role: 'PRODUCTION',
      departmentId: fx.departments.QC,
      passwordHash: await hashPassword(TEST_PASSWORD),
    },
  });
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
  logistics = api(app, await login(app, 'logistics'));
  production = api(app, await login(app, 'production'));
  qcUser = api(app, await login(app, 'qc'));
  packing = api(app, await login(app, 'packing'));
  otherProduction = api(app, await login(app, 'production-other'));
});

afterAll(async () => {
  await app.close();
});

const dueDate = () => new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);

async function createOrder(): Promise<{ id: string; orderNo: string }> {
  const response = await admin('POST', '/api/v1/orders', {
    customerId: fx.customerId,
    customerContact: '王工',
    dueDate: dueDate(),
    remark: '集成测试订单',
    items: [{ productName: '不锈钢法兰组件', spec: 'DN50', quantity: 100, unitPrice: '12.50' }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data;
}

describe('订单主链（M 闭环）', () => {
  it('现场角色不能创建订单', async () => {
    const response = await production('POST', '/api/v1/orders', {
      customerId: fx.customerId,
      dueDate: dueDate(),
      items: [{ productName: 'x', spec: 'y', quantity: 1, unitPrice: '1.00' }],
    });
    expect(response.status).toBe(403);
  });

  it('管理员创建订单后进入待采购', async () => {
    const order = await createOrder();
    expect(order.orderNo).toMatch(/^XZ-\d{8}-\d{4,}$/);

    const detail = await admin('GET', `/api/v1/orders/${order.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('PENDING_PURCHASE');
    expect(detail.body.data.flow.quantities.orderQty).toBe(100);
    expect(detail.body.data.allowedActions).toContain('create-purchase');
  });

  it('采购单幂等：同一把钥匙重放不会重复建单', async () => {
    const order = await createOrder();
    const key = `purchase-${order.id}`;
    const payload = {
      supplierId: fx.supplierId,
      partId: fx.partId,
      quantity: 100,
      unitPrice: '5.00',
    };

    const first = await admin('POST', `/api/v1/orders/${order.id}/purchase`, payload, {
      'idempotency-key': key,
    });
    expect(first.status).toBe(201);
    const purchaseId = first.body.data.flow.purchase.id;

    const replay = await admin('POST', `/api/v1/orders/${order.id}/purchase`, payload, {
      'idempotency-key': key,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const purchases = await prisma.purchaseOrder.count({ where: { orderId: order.id } });
    expect(purchases).toBe(1);

    const detail = await admin('GET', `/api/v1/orders/${order.id}`);
    expect(detail.body.data.flow.purchase.id).toBe(purchaseId);
    expect(detail.body.data.status).toBe('PURCHASING');
  });

  it('一次完整流转：到货 → 生产 → 质检 → 包装 → 发货 → 完成', async () => {
    const order = await createOrder();

    // 采购
    const purchase = await admin('POST', `/api/v1/orders/${order.id}/purchase`, {
      supplierId: fx.supplierId,
      partId: fx.partId,
      quantity: 100,
      unitPrice: '5.00',
    });
    expect(purchase.status).toBe(201);
    const purchaseId = purchase.body.data.flow.purchase.id;

    // 到货超量被拒
    const overArrival = await logistics('POST', `/api/v1/purchases/${purchaseId}/arrivals`, {
      quantity: 120,
    });
    expect(overArrival.status).toBe(422);
    expect(overArrival.body.error?.code).toBe('ARRIVAL_EXCEEDS_REMAINING');

    // 到齐
    const arrival = await logistics('POST', `/api/v1/purchases/${purchaseId}/arrivals`, {
      quantity: 100,
    });
    expect(arrival.status).toBe(201);

    // 错部门不能承接
    const wrongDept = await admin('POST', `/api/v1/orders/${order.id}/productions`, {
      departmentId: fx.departments.QC,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
    });
    expect(wrongDept.status).toBe(422);
    expect(wrongDept.body.error?.code).toBe('DEPARTMENT_CATEGORY_MISMATCH');

    // 下发生产
    const dispatched = await admin('POST', `/api/v1/orders/${order.id}/productions`, {
      departmentId: fx.departments.PROD,
      employeeId: fx.employeeId,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
      unitPriceVisible: true,
    });
    expect(dispatched.status).toBe(201);
    const productionId = dispatched.body.data.flow.production.id;

    // 角色不对直接拒绝
    const wrongRoleFeedback = await qcUser('POST', `/api/v1/productions/${productionId}/feedback`, {
      quantity: 100,
    });
    expect(wrongRoleFeedback.status).toBe(403);

    // 角色对但不是本部门，同样不能反馈
    const strangerFeedback = await otherProduction(
      'POST',
      `/api/v1/productions/${productionId}/feedback`,
      { quantity: 100 },
    );
    expect(strangerFeedback.status).toBe(403);

    // 本部门反馈
    const feedback = await production('POST', `/api/v1/productions/${productionId}/feedback`, {
      quantity: 100,
    });
    expect(feedback.status).toBe(201);

    // 下发质检
    expect((await admin('POST', `/api/v1/orders/${order.id}/qc-dispatch`)).status).toBe(201);

    // 数量不平
    const mismatch = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 100,
      qualifiedQty: 90,
      unqualifiedQty: 5,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error?.code).toBe('QC_QTY_MISMATCH');

    // M 版本不支持部分合格
    const partial = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 100,
      qualifiedQty: 90,
      unqualifiedQty: 10,
    });
    expect(partial.status).toBe(422);
    expect(partial.body.error?.code).toBe('QC_PARTIAL_NOT_SUPPORTED');

    // 全合格
    const record = await qcUser('POST', `/api/v1/productions/${productionId}/qc-records`, {
      inspectedQty: 100,
      qualifiedQty: 100,
      unqualifiedQty: 0,
    });
    expect(record.status).toBe(201);
    const qcRecordId = record.body.data.flow.qc.id;

    // 放行
    const decision = await admin('POST', `/api/v1/qc-records/${qcRecordId}/decision`, {
      decision: 'PASS',
    });
    expect(decision.status).toBe(201);
    expect(decision.body.data.status).toBe('QC_DONE');

    // 下发包装
    expect((await admin('POST', `/api/v1/orders/${order.id}/packing-dispatch`)).status).toBe(201);

    // 超量包装被拒
    const overPack = await packing('POST', `/api/v1/orders/${order.id}/packing-records`, {
      quantity: 120,
    });
    expect(overPack.status).toBe(422);
    expect(overPack.body.error?.code).toBe('PACKING_EXCEEDS_REMAINING');

    // 包装
    const packed = await packing('POST', `/api/v1/orders/${order.id}/packing-records`, {
      quantity: 100,
    });
    expect(packed.status).toBe(201);

    // 触发发货
    expect((await admin('POST', `/api/v1/orders/${order.id}/shipping-trigger`)).status).toBe(201);

    // 超量发货被拒
    const overShip = await logistics('POST', `/api/v1/orders/${order.id}/shipment-records`, {
      quantity: 120,
    });
    expect(overShip.status).toBe(422);
    expect(overShip.body.error?.code).toBe('SHIPMENT_EXCEEDS_LIMIT');

    // 足量发货完成
    const shipped = await logistics('POST', `/api/v1/orders/${order.id}/shipment-records`, {
      quantity: 100,
    });
    expect(shipped.status).toBe(201);
    expect(shipped.body.data.status).toBe('COMPLETED');

    const detail = await admin('GET', `/api/v1/orders/${order.id}`);
    expect(detail.body.data.flow.quantities.dueRemaining).toBe(0);
    expect(detail.body.data.flow.quantities.shippableRemaining).toBe(0);
    expect(detail.body.data.flow.profit.sales).toBe('1250.00');
    // 1250 销售额 - 500 采购成本 - 100 件 × 2.00 生产成本
    expect(detail.body.data.flow.profit.profit).toBe('550.00');
  });

  it('状态不匹配时拒绝越级操作', async () => {
    const order = await createOrder();
    const response = await admin('POST', `/api/v1/orders/${order.id}/packing-dispatch`);
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('ORDER_STATUS_CONFLICT');
  });
});

describe('时间线与审计', () => {
  it('每次写操作都留时间线与审计', async () => {
    const order = await createOrder();
    const detail = await admin('GET', `/api/v1/orders/${order.id}`);
    expect(detail.body.data.timeline.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.data.timeline[0].type).toBe('ORDER_CREATED');

    const audit = await admin('GET', `/api/v1/audit-logs?resourceId=${order.id}&pageSize=20`);
    expect(audit.status).toBe(200);
    expect(audit.body.data.some((row: { action: string }) => row.action === 'order.create')).toBe(true);
  });

  it('普通角色不能读取审计日志', async () => {
    const response = await logistics('GET', '/api/v1/audit-logs');
    expect(response.status).toBe(403);
  });
});