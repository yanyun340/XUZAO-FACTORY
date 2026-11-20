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
let production: ReturnType<typeof api>;
let otherProduction: ReturnType<typeof api>;
let logistics: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
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
  production = api(app, await login(app, 'production'));
  otherProduction = api(app, await login(app, 'production-other'));
  logistics = api(app, await login(app, 'logistics'));
});

afterAll(async () => {
  await app.close();
});

async function createDispatchedOrder() {
  const order = await admin('POST', '/api/v1/orders', {
    customerId: fx.customerId,
    dueDate: '2026-12-31',
    items: [{ productName: '价格权限测试件', spec: 'P-01', quantity: 100, unitPrice: '12.50' }],
  });
  expect(order.status).toBe(201);

  const purchase = await admin('POST', `/api/v1/orders/${order.body.data.id}/purchase`, {
    supplierId: fx.supplierId,
    partId: fx.partId,
    quantity: 100,
    unitPrice: '5.00',
  });
  expect(purchase.status).toBe(201);

  const arrival = await logistics(
    'POST',
    `/api/v1/purchases/${purchase.body.data.flow.purchase.id}/arrivals`,
    { quantity: 100 },
  );
  expect(arrival.status).toBe(201);

  const dispatched = await admin('POST', `/api/v1/orders/${order.body.data.id}/productions`, {
    departmentId: fx.departments.PROD,
    employeeId: fx.employeeId,
    processName: '车削',
    quantity: 100,
    unitPrice: '2.00',
    unitPriceVisible: false,
  });
  expect(dispatched.status).toBe(201);

  return {
    orderId: order.body.data.id as string,
    productionId: dispatched.body.data.flow.production.id as string,
  };
}

describe('工艺单价可见范围（R08F）', () => {
  it('任务开关、部门开关分别生效，且不越部门泄露', async () => {
    const { orderId, productionId } = await createDispatchedOrder();

    const hidden = await production('GET', `/api/v1/orders/${orderId}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.flow.production.unitPriceForWorker).toBeNull();

    // 任务级开关
    const opened = await admin('PATCH', `/api/v1/productions/${productionId}/price-visibility`, {
      visible: true,
    });
    expect(opened.status).toBe(200);

    const taskVisible = await production('GET', `/api/v1/orders/${orderId}`);
    expect(taskVisible.body.data.flow.production.unitPriceForWorker).toBe('2.00');

    // 关掉任务开关，改用部门开关
    await admin('PATCH', `/api/v1/productions/${productionId}/price-visibility`, {
      visible: false,
    });
    const deptOn = await admin('PATCH', `/api/v1/departments/${fx.departments.PROD}`, {
      unitPriceVisible: true,
    });
    expect(deptOn.status).toBe(200);

    const deptVisible = await production('GET', `/api/v1/orders/${orderId}`);
    expect(deptVisible.body.data.flow.production.unitPriceForWorker).toBe('2.00');

    // 外部门即使自己的部门开关打开，也看不到别的部门任务价格
    await admin('PATCH', `/api/v1/departments/${fx.departments.QC}`, {
      unitPriceVisible: true,
    });
    const outsider = await otherProduction('GET', `/api/v1/orders/${orderId}`);
    expect(outsider.status).toBe(200);
    expect(outsider.body.data.flow.production.unitPriceForWorker).toBeNull();

    // 现场角色不能改开关
    const forbidden = await production(
      'PATCH',
      `/api/v1/productions/${productionId}/price-visibility`,
      { visible: true },
    );
    expect(forbidden.status).toBe(403);

    // 历史可查：两次任务级开关变更
    const history = await admin(
      'GET',
      `/api/v1/productions/${productionId}/price-visibility-history`,
    );
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.map((row: { after: { unitPriceVisible: boolean } }) => row.after.unitPriceVisible)).toEqual([
      true,
      false,
    ]);
  });

  it('现场角色不能导出订单，附件下载要求登录', async () => {
    const exportDenied = await logistics('GET', '/api/v1/orders/export.xlsx');
    expect(exportDenied.status).toBe(403);

    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/attachments/00000000-0000-4000-8000-000000000000/download',
    });
    expect(anonymous.statusCode).toBe(401);
  });
});