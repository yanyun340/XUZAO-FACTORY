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

const dueDate = () => new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);

async function createOrder(customerId: string, quantity = 100) {
  const response = await admin('POST', '/api/v1/orders', {
    customerId,
    dueDate: dueDate(),
    items: [{ productName: '法兰组件', spec: 'DN50', quantity, unitPrice: '12.50' }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data;
}

describe('基础数据修改与停用', () => {
  it('改客户名不影响历史订单里的快照', async () => {
    const customer = await admin('POST', '/api/v1/customers', {
      name: '宁波测试客户',
      contact: '王工',
      phone: '0574-0000000',
    });
    expect(customer.status).toBe(201);

    const order = await createOrder(customer.body.data.id);

    const renamed = await admin('PATCH', `/api/v1/customers/${customer.body.data.id}`, {
      name: '宁波测试客户（改名）',
      contact: null,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('宁波测试客户（改名）');
    expect(renamed.body.data.contact).toBeNull();

    const detail = await admin('GET', `/api/v1/orders/${order.id}`);
    expect(detail.body.data.customerName).toBe('宁波测试客户');
    expect(detail.body.data.customerId).toBe(customer.body.data.id);

    const list = await admin('GET', '/api/v1/customers?keyword=改名');
    expect(list.body.data).toHaveLength(1);
  });

  it('停用供应商后不能新建采购，但已有采购仍可读', async () => {
    const supplier = await admin('POST', '/api/v1/suppliers', { name: '无锡测试供应商' });
    expect(supplier.status).toBe(201);

    const purchasedOrder = await createOrder(fx.customerId);
    const purchase = await admin('POST', `/api/v1/orders/${purchasedOrder.id}/purchase`, {
      supplierId: supplier.body.data.id,
      partId: fx.partId,
      quantity: 100,
      unitPrice: '5.00',
    });
    expect(purchase.status).toBe(201);

    const disabled = await admin('PATCH', `/api/v1/suppliers/${supplier.body.data.id}`, {
      active: false,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.active).toBe(false);

    const newOrder = await createOrder(fx.customerId);
    const rejected = await admin('POST', `/api/v1/orders/${newOrder.id}/purchase`, {
      supplierId: supplier.body.data.id,
      partId: fx.partId,
      quantity: 100,
      unitPrice: '5.00',
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error?.code).toBe('SUPPLIER_NOT_FOUND');

    const detail = await admin('GET', `/api/v1/orders/${purchasedOrder.id}`);
    expect(detail.body.data.flow.purchase.supplierName).toBe('无锡测试供应商');
  });

  it('停用员工后不能再被指派生产任务', async () => {
    const order = await createOrder(fx.customerId);
    const purchase = await admin('POST', `/api/v1/orders/${order.id}/purchase`, {
      supplierId: fx.supplierId,
      partId: fx.partId,
      quantity: 100,
      unitPrice: '5.00',
    });
    expect(purchase.status).toBe(201);
    const arrival = await account('logistics')('POST', `/api/v1/purchases/${purchase.body.data.flow.purchase.id}/arrivals`, {
      quantity: 100,
    });
    expect(arrival.status).toBe(201);

    const disabled = await admin('PATCH', `/api/v1/employees/${fx.employeeId}`, { active: false });
    expect(disabled.status).toBe(200);

    const dispatch = await admin('POST', `/api/v1/orders/${order.id}/productions`, {
      departmentId: fx.departments.PROD,
      employeeId: fx.employeeId,
      processName: '车削',
      quantity: 100,
      unitPrice: '2.00',
    });
    expect(dispatch.status).toBe(422);
    expect(dispatch.body.error?.code).toBe('EMPLOYEE_NOT_FOUND');
  });

  it('编码重复明确返回 409', async () => {
    const duplicate = await admin('POST', '/api/v1/customers', {
      code: 'CUS-0001',
      name: '重复编码客户',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error?.code).toBe('DUPLICATE_VALUE');
  });

  it('空 PATCH 与不存在的资源按契约拒绝', async () => {
    const empty = await admin('PATCH', `/api/v1/customers/${fx.customerId}`, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error?.code).toBe('VALIDATION_ERROR');

    const missing = await admin('PATCH', '/api/v1/customers/11111111-1111-4111-8111-111111111111', {
      name: '不存在',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('现场角色不能修改基础数据', async () => {
    const logistics = account('logistics');
    const response = await logistics('PATCH', `/api/v1/customers/${fx.customerId}`, {
      name: '越权改名',
    });
    expect(response.status).toBe(403);
  });

  it('修改动作写入审计', async () => {
    const actions = await prisma.auditLog.findMany({
      where: { action: { in: ['customer.update', 'supplier.update', 'employee.update'] } },
      select: { action: true },
      distinct: ['action'],
    });
    expect(actions.map((row) => row.action).sort()).toEqual([
      'customer.update',
      'employee.update',
      'supplier.update',
    ]);
  });
});

function account(username: string) {
  return api(app, sessions[username]!);
}

const sessions: Record<string, string> = {};

beforeAll(async () => {
  for (const username of ['logistics', 'production', 'qc', 'packing']) {
    sessions[username] = await login(app, username);
  }
});